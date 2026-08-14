import { Agent, fetch as undiciFetch } from 'undici';
import { Innertube, Log } from 'youtubei.js';
import type { Logger } from 'yt-cast-receiver';

export interface RelatedVideo {
  id: string;
  title: string;
  author?: string;
}

export interface CaptionTrack {
  label: string;
  lang: string;
  url: string;
}

export interface VideoDetails {
  videos: RelatedVideo[];
  // youtube's official up-next pick, null when unavailable
  autoplayId: string | null;
  // auto-generated (asr) caption tracks; manual subs come via ytdl_hook
  captions: CaptionTrack[];
  // db above youtube's -14 lufs reference, null when unavailable
  loudnessDb: number | null;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const MAX_RESULTS = 15;
const CACHE_LIMIT = 30;

// undici's fetch brand-checks request objects, so the built-in Request
// instances youtubei.js passes would be stringified; unpack them instead.
// init already carries the final body/headers, only method lives on the request
/* eslint-disable @typescript-eslint/no-explicit-any */
async function isolatedFetch(dispatcher: Agent, input: any, init?: any): Promise<any> {
  if (input instanceof Request) {
    const body = init?.body ?? (input.body ? await input.arrayBuffer() : undefined);
    return undiciFetch(input.url, { ...init, method: input.method, body, dispatcher });
  }
  return undiciFetch(input, { ...init, dispatcher });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// per-video details (recommendations + loudness) via the innertube api
export default class RelatedVideosService {
  #yt: Promise<Innertube> | null = null;
  #cache = new Map<string, VideoDetails>();
  #logger: Logger;
  #cookieProvider: (() => string | null) | null = null;
  // yt-cast-receiver holds long-poll connections to www.youtube.com on the
  // global fetch pool; sharing it makes our requests hang forever
  #dispatcher = new Agent();

  constructor(logger: Logger, cookieProvider?: () => string | null) {
    this.#logger = logger;
    this.#cookieProvider = cookieProvider ?? null;
    try {
      Log.setLevel(Log.Level.ERROR); // parser warnings are noisy
    }
    catch {
      // best effort
    }
  }

  async get(videoId: string): Promise<VideoDetails> {
    const cached = this.#cache.get(videoId);
    if (cached) {
      return cached;
    }
    this.#logger.debug(`[related] fetching details for ${videoId}`);
    // full session needed for audio_config; cookies get past bot checks that
    // otherwise withhold the player response including loudness data
    this.#yt ??= Innertube.create({
      cookie: this.#cookieProvider?.() ?? undefined,
      // undici's own fetch pairs with the undici agent regardless of node version
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (input: any, init?: any) => isolatedFetch(this.#dispatcher, input, init)
    });
    let yt: Innertube;
    try {
      yt = await this.#yt;
    }
    catch (err) {
      // a failed session must not poison later calls
      this.#yt = null;
      throw err;
    }
    this.#logger.debug('[related] innertube session ready');
    const info = await yt.getInfo(videoId);
    const feed: unknown[] = (info as unknown as { watch_next_feed?: unknown[] }).watch_next_feed ?? [];
    const videos: RelatedVideo[] = [];
    for (const item of feed) {
      const video = extractVideo(item);
      if (video) {
        videos.push(video);
      }
      if (videos.length >= MAX_RESULTS) {
        break;
      }
    }

    const rawAutoplayId = (info as unknown as {
      autoplay_video_endpoint?: { payload?: { videoId?: unknown } }
    }).autoplay_video_endpoint?.payload?.videoId;
    const autoplayId = typeof rawAutoplayId === 'string' && VIDEO_ID_RE.test(rawAutoplayId) ? rawAutoplayId : null;

    const rawLoudness = (info as unknown as {
      player_config?: { audio_config?: { loudness_db?: number } }
    }).player_config?.audio_config?.loudness_db;
    const loudnessDb = typeof rawLoudness === 'number' && isFinite(rawLoudness) ? rawLoudness : null;

    // caption urls from the web client are pot-gated and come back empty;
    // the tv client's are directly fetchable, so captions need their own call
    let captions: CaptionTrack[] = [];
    try {
      const basic = await yt.getBasicInfo(videoId, { client: 'TV' });
      captions = extractCaptions(basic);
    }
    catch (err) {
      this.#logger.debug('[related] caption lookup failed:', err instanceof Error ? err.message : err);
    }

    const details: VideoDetails = { videos, autoplayId, captions, loudnessDb };
    this.#logger.debug(`[related] ${videos.length} recommendations, up next ${autoplayId ?? 'n/a'}, ${captions.length} auto caption(s), loudness ${loudnessDb ?? 'n/a'} dB for ${videoId}`);
    if (this.#cache.size >= CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest) {
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(videoId, details);
    return details;
  }
}

function extractCaptions(info: unknown): CaptionTrack[] {
  const rawTracks = (info as {
    captions?: { caption_tracks?: { base_url?: unknown, name?: unknown, language_code?: unknown, kind?: unknown }[] }
  }).captions?.caption_tracks ?? [];
  const captions: CaptionTrack[] = [];
  for (const track of rawTracks) {
    if (track.kind !== 'asr' || typeof track.base_url !== 'string') {
      continue;
    }
    try {
      const url = new URL(track.base_url);
      url.searchParams.set('fmt', 'vtt');
      const lang = typeof track.language_code === 'string' ? track.language_code : '';
      captions.push({ label: textOf(track.name) || lang, lang, url: url.toString() });
    }
    catch {
      // malformed base url, skip
    }
  }
  return captions;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractVideo(item: any): RelatedVideo | null {
  try {
    // newer ui model
    if (item.type === 'LockupView') {
      if (item.content_type !== 'VIDEO' || typeof item.content_id !== 'string') {
        return null;
      }
      const title = textOf(item.metadata?.title);
      const byline = textOf(item.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text);
      return title ? { id: item.content_id, title, author: byline || undefined } : null;
    }
    // legacy model
    if (item.type === 'CompactVideo' && typeof item.id === 'string') {
      const title = textOf(item.title);
      return title ? { id: item.id, title, author: textOf(item.author?.name) || undefined } : null;
    }
  }
  catch {
    // fall through
  }
  return null;
}

function textOf(value: any): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value.toString === 'function') {
    const s = String(value);
    return s === '[object Object]' ? '' : s;
  }
  return '';
}
