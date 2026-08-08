import { Constants, type Logger } from 'yt-cast-receiver';
import type MpvController from './mpv/MpvController.js';
import type MpvPlayer from './player/MpvPlayer.js';
import type RelatedVideosService from './related.js';
import { watchUrlFromVideoId } from './util/youtubeUrl.js';

const { PLAYER_STATUSES } = Constants;

const HISTORY_LIMIT = 20;

// direct mpv loads bypass the cast queue, so the cast library never sees
// their eof and cannot autoplay. this coordinator owns that path: it tracks
// the directly played video and on natural eof plays youtube's up-next pick.
// ownership is mutually exclusive with MpvPlayer's eof handler, which only
// acts when a cast session is playing/paused
export default class DirectPlayback {
  #mpv: MpvController;
  #player: MpvPlayer;
  #related: RelatedVideosService;
  #autoplay: boolean;
  #log: Logger;
  #activeVideoId: string | null = null;
  // recently played ids, oldest first; avoids autoplay loops
  #history: string[] = [];
  // bumped on every user-initiated play to invalidate in-flight autoplay
  #generation = 0;

  constructor(
    mpv: MpvController,
    player: MpvPlayer,
    related: RelatedVideosService,
    autoplay: boolean,
    logger: Logger
  ) {
    this.#mpv = mpv;
    this.#player = player;
    this.#related = related;
    this.#autoplay = autoplay;
    this.#log = logger;

    mpv.on('ended', (reason: string) => {
      void this.#onEnded(reason);
    });

    // user closed the window; do not resurrect it
    mpv.on('exited', () => {
      this.#activeVideoId = null;
    });

    // cast session took over; stopped is excluded because play() itself
    // notifies stopped to stale senders
    player.on('state', ({ current }) => {
      if (current.status === PLAYER_STATUSES.PLAYING
        || current.status === PLAYER_STATUSES.PAUSED
        || current.status === PLAYER_STATUSES.LOADING) {
        this.#activeVideoId = null;
      }
    });
  }

  // active cast senders are told playback stopped so they do not show
  // stale state
  async play(url: string, time: number, videoId?: string): Promise<boolean> {
    this.#generation++;
    const castWasActive = this.#player.status === PLAYER_STATUSES.PLAYING
      || this.#player.status === PLAYER_STATUSES.PAUSED
      || this.#player.status === PLAYER_STATUSES.LOADING;

    this.#log.info(`[playback] direct play: ${url} at ${time}s`);
    const ok = await this.#mpv.load(url, time);
    if (castWasActive) {
      await this.#player.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
    }
    this.#activeVideoId = ok && videoId ? videoId : null;
    if (videoId) {
      this.#remember(videoId);
    }
    return ok;
  }

  async #onEnded(reason: string): Promise<void> {
    const endedId = this.#activeVideoId;
    if (reason !== 'eof') {
      // stop comes from our own commands, error would loop on retry
      this.#activeVideoId = null;
      return;
    }
    if (!this.#autoplay || !endedId) {
      return;
    }
    // cast playback eof belongs to MpvPlayer
    if (this.#player.status === PLAYER_STATUSES.PLAYING || this.#player.status === PLAYER_STATUSES.PAUSED) {
      return;
    }
    this.#activeVideoId = null;

    const generation = this.#generation;
    let nextId: string | null = null;
    try {
      const { autoplayId, videos } = await this.#related.get(endedId);
      nextId = autoplayId && !this.#history.includes(autoplayId)
        ? autoplayId
        : videos.find((v) => !this.#history.includes(v.id))?.id ?? null;
    }
    catch (err) {
      this.#log.warn('[playback] autoplay lookup failed:', err instanceof Error ? err.message : err);
      return;
    }
    // a newer play request won while we were fetching
    if (generation !== this.#generation) {
      return;
    }
    if (!nextId) {
      this.#log.info('[playback] no autoplay candidate, stopping');
      return;
    }
    this.#log.info(`[playback] up next: ${nextId}`);
    await this.play(watchUrlFromVideoId(nextId), 0, nextId);
  }

  #remember(videoId: string): void {
    const i = this.#history.indexOf(videoId);
    if (i !== -1) {
      this.#history.splice(i, 1);
    }
    this.#history.push(videoId);
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.shift();
    }
  }
}
