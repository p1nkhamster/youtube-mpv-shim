import { Player, Constants, type Video, type Volume, type Logger } from 'yt-cast-receiver';
import type MpvController from '../mpv/MpvController.js';
import { watchUrlFromVideoId } from '../util/youtubeUrl.js';

const { PLAYER_STATUSES } = Constants;

// the cast library owns the queue and autoplay; mpv plays one video at a
// time and natural eof asks the library for the next one
export default class MpvPlayer extends Player {
  #mpv: MpvController;
  #log: Logger;

  constructor(mpv: MpvController, logger: Logger) {
    super();
    this.#mpv = mpv;
    this.#log = logger;

    mpv.on('ended', (reason: string) => {
      void this.#onEnded(reason);
    });

    mpv.on('external-prop-change', (name: string, value: unknown) => {
      void this.#onExternalChange(name, value);
    });

    mpv.on('exited', () => {
      if (this.status === PLAYER_STATUSES.PLAYING || this.status === PLAYER_STATUSES.PAUSED || this.status === PLAYER_STATUSES.LOADING) {
        this.#log.info('[player] mpv exited during playback; notifying senders');
        void this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
      }
    });
  }

  protected async doPlay(video: Video, position: number): Promise<boolean> {
    const url = watchUrlFromVideoId(video.id);
    this.#log.info(`[player] play ${url} @ ${position}s`);
    const ok = await this.#mpv.load(url, position);
    if (!ok) {
      this.#log.error(
        `[player] failed to load video ${video.id}. ` +
        'If this keeps happening, make sure yt-dlp is installed and up to date (yt-dlp -U or your package manager).'
      );
    }
    return ok;
  }

  protected async doPause(): Promise<boolean> {
    try {
      await this.#mpv.setPause(true);
      return true;
    }
    catch {
      return false;
    }
  }

  protected async doResume(): Promise<boolean> {
    try {
      await this.#mpv.setPause(false);
      return true;
    }
    catch {
      return false;
    }
  }

  protected async doStop(): Promise<boolean> {
    try {
      await this.#mpv.stop();
      return true;
    }
    catch {
      // not running counts as stopped
      return true;
    }
  }

  protected async doSeek(position: number): Promise<boolean> {
    try {
      await this.#mpv.seekAbsolute(position);
      return true;
    }
    catch {
      return false;
    }
  }

  protected async doSetVolume(volume: Volume): Promise<boolean> {
    try {
      await this.#mpv.setVolume(volume.level, volume.muted);
      return true;
    }
    catch {
      return false;
    }
  }

  protected async doGetVolume(): Promise<Volume> {
    return this.#mpv.getVolume();
  }

  protected async doGetPosition(): Promise<number> {
    return this.#mpv.getPosition();
  }

  protected async doGetDuration(): Promise<number> {
    return this.#mpv.getDuration();
  }

  async #onEnded(reason: string): Promise<void> {
    if (reason === 'eof') {
      if (this.status !== PLAYER_STATUSES.PLAYING && this.status !== PLAYER_STATUSES.PAUSED) {
        return;
      }
      this.#log.info('[player] video ended; requesting next in queue/autoplay');
      const playedNext = await this.next();
      if (!playedNext) {
        this.#log.info('[player] end of queue, no autoplay video');
        await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
      }
    }
    else if (reason === 'error') {
      this.#log.error(
        '[player] playback ended with an error. ' +
        'Check that yt-dlp is up to date; age-restricted videos need cookies (see README).'
      );
      await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
    }
    // stop and other reasons originate from our own commands; the library
    // already knows about those state changes
  }

  async #onExternalChange(name: string, value: unknown): Promise<void> {
    if (this.status !== PLAYER_STATUSES.PLAYING && this.status !== PLAYER_STATUSES.PAUSED) {
      return;
    }
    if (name === 'pause') {
      const paused = value === true;
      this.#log.debug(`[player] user ${paused ? 'paused' : 'resumed'} in mpv window`);
      await this.notifyExternalStateChange(paused ? PLAYER_STATUSES.PAUSED : PLAYER_STATUSES.PLAYING);
    }
    else if (name === 'volume' || name === 'mute') {
      this.#log.debug(`[player] ${name} changed in mpv window`);
      await this.notifyExternalStateChange();
    }
  }
}
