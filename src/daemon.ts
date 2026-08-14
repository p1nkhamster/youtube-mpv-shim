import { execFile } from 'child_process';
import type http from 'http';
import { fileURLToPath } from 'url';
import YouTubeCastReceiver, { Constants } from 'yt-cast-receiver';
import type { Config } from './config.js';
import { startHttpApi } from './http/api.js';
import MpvController from './mpv/MpvController.js';
import DirectPlayback from './playback.js';
import MpvPlayer from './player/MpvPlayer.js';
import PlayerStateStore from './playerState.js';
import RelatedVideosService from './related.js';
import SponsorBlockService from './sponsorblock.js';
import { loadYouTubeCookies, profileFromMpvArgs } from './util/browserCookies.js';
import JsonFileDataStore from './util/JsonFileDataStore.js';
import ConsoleLogger from './util/logger.js';
import { configDir, migrateLegacyState, spawnEnv } from './util/paths.js';
import { parseYouTubeUrl, watchUrlFromVideoId } from './util/youtubeUrl.js';

const MENU_SCRIPT_PATH = fileURLToPath(new URL('../assets/ytshim_menu.lua', import.meta.url));
const MENU_SCRIPT_NAME = 'ytshim_menu';
const STABLE_VOLUME_LABEL = 'ytshim-stable-volume';

// loudness_db is db above youtube's -14 lufs reference; the official client
// applies the negation as static gain. limiter guards boosts against clipping
// since the true peak is unknown
function stableVolumeGainFilter(loudnessDb: number): string {
  const gain = Math.max(-30, Math.min(12, -loudnessDb));
  const volume = `volume=${gain.toFixed(2)}dB`;
  return gain > 0
    ? `lavfi=[${volume},alimiter=limit=0.98]`
    : `lavfi=[${volume}]`;
}

export default class Daemon {
  #cfg: Config;
  #logger: ConsoleLogger;
  #mpv: MpvController;
  #player: MpvPlayer;
  #receiver: YouTubeCastReceiver;
  #httpServer: http.Server | null = null;
  #stopping = false;
  #related: RelatedVideosService;
  #sponsorBlockService: SponsorBlockService;
  #currentVideoId: string | null = null;
  #playerState: PlayerStateStore | null = null;
  #playback: DirectPlayback;

  constructor(cfg: Config) {
    this.#cfg = cfg;
    this.#logger = new ConsoleLogger(cfg.logLevel);
    migrateLegacyState(this.#logger);
    // cookie usage is opt-in: off unless browserProfile is 'auto' or a path
    const profileDir = cfg.browserProfile === 'auto'
      ? profileFromMpvArgs(cfg.mpv.extraArgs)
      : (cfg.browserProfile || null);
    if (profileDir) {
      this.#logger.info(`[daemon] using YouTube cookies from browser profile: ${profileDir}`);
    }
    else if (cfg.browserProfile === 'auto') {
      this.#logger.warn('[daemon] browserProfile is "auto" but no cookies-from-browser=firefox:<path> entry found in mpv.extraArgs');
    }
    this.#related = new RelatedVideosService(
      this.#logger,
      profileDir ? () => loadYouTubeCookies(profileDir, this.#logger) : undefined
    );
    this.#sponsorBlockService = new SponsorBlockService({
      apiUrl: cfg.sponsorBlockApiUrl,
      behavior: cfg.sponsorBlockBehavior
    }, this.#logger);
    if (cfg.persistState) {
      this.#playerState = new PlayerStateStore(configDir(), this.#logger);
    }
    this.#mpv = new MpvController(
      {
        ...cfg.mpv,
        menuScriptPath: cfg.menu ? MENU_SCRIPT_PATH : undefined,
        initialProperties: this.#playerState ? () => this.#playerState!.initialProperties() : undefined
      },
      this.#logger
    );
    if (this.#playerState) {
      const store = this.#playerState;
      this.#mpv.on('prop-change', (name: string, value: unknown) => store.onPropChange(name, value));
    }
    this.#player = new MpvPlayer(this.#mpv, this.#logger);
    this.#playback = new DirectPlayback(this.#mpv, this.#player, this.#related, cfg.autoplay, this.#logger);
    this.#wireMenuBridge();
    this.#receiver = new YouTubeCastReceiver(this.#player, {
      device: { name: cfg.deviceName, screenName: cfg.deviceName },
      dial: { port: cfg.dialPort },
      app: {
        enableAutoplayOnConnect: cfg.autoplayOnConnect,
        resetPlayerOnDisconnectPolicy: Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED
      },
      dataStore: new JsonFileDataStore(configDir()),
      logger: this.#logger,
      logLevel: cfg.logLevel
    });

    this.#receiver.on('senderConnect', (sender) => {
      this.#logger.info(`[receiver] sender connected: ${sender.name} (${sender.client?.name ?? 'unknown client'})`);
    });
    this.#receiver.on('senderDisconnect', (sender, implicit) => {
      this.#logger.info(`[receiver] sender disconnected: ${sender.name}${implicit ? ' (implicit)' : ''}`);
    });
    this.#receiver.on('error', (err) => {
      this.#logger.error('[receiver] error:', err);
    });
    this.#receiver.on('terminate', (err) => {
      this.#logger.error('[receiver] terminated due to irrecoverable error:', err);
      process.exitCode = 1;
      void this.stop().then(() => process.exit(1));
    });
  }

  #wireMenuBridge(): void {
    if (!this.#cfg.menu) {
      return;
    }

    this.#mpv.on('file-loaded', () => {
      void (async () => {
        const path = await this.#mpv.queryPath();
        const parsed = path ? parseYouTubeUrl(path.replace(/^ytdl:\/\//, '')) : null;
        this.#currentVideoId = parsed?.videoId ?? null;
        this.#logger.debug(`[related] current video: ${this.#currentVideoId ?? `none (path: ${path})`}`);
        if (this.#currentVideoId) {
          // sequenced so the captions push hits the details cache
          const id = this.#currentVideoId;
          void this.#pushRelated(id).then(() => this.#pushCaptions(id));
        }
        if (this.#stableVolumeEnabled()) {
          void this.#applyStableVolume();
        }
        if (this.#sponsorBlockEnabled() && this.#currentVideoId) {
          void this.#pushSponsorSegments(this.#currentVideoId);
        }
      })();
    });

    // the script cannot know toggle states on its own; push on every spawn
    this.#mpv.on('ready', () => {
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-stable-volume', this.#stableVolumeEnabled() ? 'on' : 'off');
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-sponsorblock', this.#sponsorBlockEnabled() ? 'on' : 'off');
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-captions-pref', this.#captionsPref());
    });

    this.#mpv.on('client-message', (args: string[]) => {
      if (args[0] !== 'ytshim') {
        return;
      }
      if (args[1] === 'play' && args[2]) {
        void this.#playback.play(watchUrlFromVideoId(args[2]), 0, args[2]);
      }
      else if (args[1] === 'request-related' && this.#currentVideoId) {
        void this.#pushRelated(this.#currentVideoId);
      }
      else if (args[1] === 'request-captions' && this.#currentVideoId) {
        void this.#pushCaptions(this.#currentVideoId);
      }
      else if (args[1] === 'stable-volume') {
        void this.#setStableVolume(args[2] === 'on');
      }
      else if (args[1] === 'sponsorblock') {
        void this.#setSponsorBlock(args[2] === 'on');
      }
      else if (args[1] === 'captions-pref' && args[2]) {
        this.#subtitlePref = args[2];
        this.#playerState?.setSubtitlePref(args[2]);
        this.#logger.debug(`[daemon] subtitle pref: ${args[2]}`);
      }
    });
  }

  #stableVolume = false;
  #subtitlePref = 'off';

  #captionsPref(): string {
    return this.#playerState ? this.#playerState.subtitlePref : this.#subtitlePref;
  }

  #stableVolumeEnabled(): boolean {
    return this.#playerState ? this.#playerState.stableVolume : this.#stableVolume;
  }

  async #setStableVolume(enabled: boolean): Promise<void> {
    this.#stableVolume = enabled;
    this.#playerState?.setStableVolume(enabled);
    this.#logger.info(`[daemon] stable volume ${enabled ? 'on' : 'off'}`);
    this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-stable-volume', enabled ? 'on' : 'off');
    if (enabled) {
      await this.#applyStableVolume();
    }
    else {
      try {
        await this.#mpv.setAudioFilterEnabled(STABLE_VOLUME_LABEL, '', false);
      }
      catch (err) {
        this.#logger.error('[daemon] failed to remove stable volume filter:', err instanceof Error ? err.message : err);
      }
    }
  }

  // static gain from youtube loudness data, loudnorm fallback without it
  async #applyStableVolume(): Promise<void> {
    let filter = this.#cfg.stableVolumeFilter;
    const videoId = this.#currentVideoId;
    if (videoId) {
      try {
        const { loudnessDb } = await this.#related.get(videoId);
        if (loudnessDb !== null) {
          filter = stableVolumeGainFilter(loudnessDb);
          this.#logger.info(`[daemon] stable volume: ${(-loudnessDb).toFixed(2)} dB gain (YouTube loudness data)`);
        }
        else {
          this.#logger.info('[daemon] stable volume: no loudness data, using loudnorm fallback');
        }
      }
      catch {
        this.#logger.warn('[daemon] stable volume: loudness fetch failed, using loudnorm fallback');
      }
    }
    // video may have changed while fetching
    if (videoId !== this.#currentVideoId || !this.#stableVolumeEnabled()) {
      return;
    }
    try {
      await this.#mpv.setAudioFilterEnabled(STABLE_VOLUME_LABEL, filter, true);
    }
    catch (err) {
      this.#logger.error('[daemon] failed to apply stable volume filter:', err instanceof Error ? err.message : err);
    }
  }

  #sponsorBlock = false;

  #sponsorBlockEnabled(): boolean {
    return this.#playerState ? this.#playerState.sponsorBlock : this.#sponsorBlock;
  }

  async #setSponsorBlock(enabled: boolean): Promise<void> {
    this.#sponsorBlock = enabled;
    this.#playerState?.setSponsorBlock(enabled);
    this.#logger.info(`[daemon] sponsorblock ${enabled ? 'on' : 'off'}`);
    this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-sponsorblock', enabled ? 'on' : 'off');
    if (enabled && this.#currentVideoId) {
      await this.#pushSponsorSegments(this.#currentVideoId);
    }
    else if (!enabled) {
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-sponsorblock-segments', JSON.stringify({ segments: [] }));
    }
  }

  async #pushSponsorSegments(videoId: string): Promise<void> {
    let segments: Awaited<ReturnType<SponsorBlockService['get']>>;
    try {
      segments = await this.#sponsorBlockService.get(videoId);
    }
    catch (err) {
      this.#logger.warn('[sponsorblock] fetch failed:', err instanceof Error ? err.message : err);
      segments = [];
    }
    // video may have changed while fetching
    if (this.#currentVideoId === videoId && this.#sponsorBlockEnabled()) {
      if (segments.length) {
        this.#logger.info(`[sponsorblock] ${segments.length} segment(s) for ${videoId}`);
      }
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-sponsorblock-segments', JSON.stringify({ segments }));
    }
  }

  async #pushRelated(videoId: string): Promise<void> {
    let payload: string;
    try {
      const { videos } = await this.#related.get(videoId);
      payload = JSON.stringify({ videos });
    }
    catch (err) {
      this.#logger.warn('[related] failed to fetch recommendations:', err instanceof Error ? err.message : err);
      payload = JSON.stringify({ videos: [] });
    }
    // video may have changed while fetching
    if (this.#currentVideoId === videoId) {
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-related', payload);
    }
  }

  async #pushCaptions(videoId: string): Promise<void> {
    let payload: string;
    try {
      const { captions } = await this.#related.get(videoId);
      payload = JSON.stringify({ tracks: captions });
    }
    catch (err) {
      this.#logger.warn('[related] failed to fetch captions:', err instanceof Error ? err.message : err);
      payload = JSON.stringify({ tracks: [] });
    }
    // video may have changed while fetching
    if (this.#currentVideoId === videoId) {
      this.#mpv.sendScriptMessage(MENU_SCRIPT_NAME, 'ytshim-captions', payload);
    }
  }

  async start(): Promise<void> {
    await this.#checkYtDlp();

    await this.#receiver.start();
    this.#logger.info(`[receiver] "${this.#cfg.deviceName}" is discoverable in the YouTube cast menu (DIAL port ${this.#cfg.dialPort})`);

    if (this.#cfg.httpPort > 0) {
      this.#httpServer = await startHttpApi({
        port: this.#cfg.httpPort,
        mpv: this.#mpv,
        playback: this.#playback,
        logger: this.#logger
      });
    }

    if (this.#cfg.showPairingCode) {
      const service = this.#receiver.getPairingCodeRequestService();
      service.on('response', (code) => {
        this.#logger.info(`[receiver] manual pairing code ("Link with TV code"): ${code}`);
      });
      service.on('error', (err) => {
        this.#logger.warn('[receiver] pairing code service error:', err.message);
      });
      service.start();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#logger.info('shutting down...');
    if (this.#httpServer) {
      this.#httpServer.close();
      this.#httpServer = null;
    }
    try {
      await this.#receiver.stop();
    }
    catch (err) {
      this.#logger.warn('[receiver] error during stop:', err instanceof Error ? err.message : err);
    }
    await this.#mpv.shutdown();
    this.#playerState?.flush();
  }

  #checkYtDlp(): Promise<void> {
    return new Promise((resolve) => {
      execFile('yt-dlp', ['--version'], { env: spawnEnv() }, (err, stdout) => {
        if (err) {
          this.#logger.warn(
            '[daemon] yt-dlp not found on PATH. mpv needs it to play YouTube URLs; install it and keep it updated (on macos: brew install yt-dlp).'
          );
        }
        else {
          this.#logger.info(`[daemon] yt-dlp ${stdout.trim()} found`);
        }
        resolve();
      });
    });
  }
}
