import { Constants, type Logger } from 'yt-cast-receiver';
import type MpvController from './mpv/MpvController.js';
import type MpvPlayer from './player/MpvPlayer.js';

const { PLAYER_STATUSES } = Constants;

// direct mpv load bypassing the cast queue; active cast senders are told
// playback stopped so they do not show stale state
export async function directPlay(
  mpv: MpvController,
  player: MpvPlayer,
  url: string,
  time: number,
  logger: Logger
): Promise<boolean> {
  const castWasActive = player.status === PLAYER_STATUSES.PLAYING
    || player.status === PLAYER_STATUSES.PAUSED
    || player.status === PLAYER_STATUSES.LOADING;

  logger.info(`[playback] direct play: ${url} at ${time}s`);
  const ok = await mpv.load(url, time);
  if (castWasActive) {
    await player.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
  }
  return ok;
}
