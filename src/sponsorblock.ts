import { createHash } from 'crypto';
import type { Logger } from 'yt-cast-receiver';
import type { SponsorBehavior } from './config.js';

export interface SponsorSegment {
  start: number;
  end: number;
  category: string;
  // skip = auto-skip, prompt = seek-to-skip
  mode: 'skip' | 'prompt';
}

export interface SponsorBlockOptions {
  apiUrl: string;
  behavior: Record<string, SponsorBehavior>;
}

interface ApiSegment {
  category?: string;
  actionType?: string;
  segment?: [number, number];
}

const CACHE_LIMIT = 30;
const FETCH_TIMEOUT_MS = 10_000;

// k-anonymity endpoint: only a 4-hex-char sha256 prefix leaves the machine
export default class SponsorBlockService {
  #opts: SponsorBlockOptions;
  #logger: Logger;
  #cache = new Map<string, SponsorSegment[]>();
  #allCategories: string[];

  constructor(opts: SponsorBlockOptions, logger: Logger) {
    this.#opts = opts;
    this.#logger = logger;
    // categories set to none are never requested
    this.#allCategories = Object.entries(opts.behavior)
      .filter(([, behavior]) => behavior !== 'none')
      .map(([category]) => category);
  }

  async get(videoId: string): Promise<SponsorSegment[]> {
    const cached = this.#cache.get(videoId);
    if (cached) {
      return cached;
    }
    if (this.#allCategories.length === 0) {
      return [];
    }

    const hashPrefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const url = `${this.#opts.apiUrl}/api/skipSegments/${hashPrefix}`
      + `?categories=${encodeURIComponent(JSON.stringify(this.#allCategories))}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const segments: SponsorSegment[] = [];
    if (res.status === 404) {
      // no segments for this hash prefix
    }
    else if (!res.ok) {
      throw new Error(`SponsorBlock API responded with HTTP ${res.status}`);
    }
    else {
      const body = await res.json() as Array<{ videoID?: string, segments?: ApiSegment[] }>;
      const entry = Array.isArray(body) ? body.find((e) => e.videoID === videoId) : undefined;
      for (const seg of entry?.segments ?? []) {
        if (
          seg.actionType === 'skip'
          && Array.isArray(seg.segment)
          && typeof seg.segment[0] === 'number'
          && typeof seg.segment[1] === 'number'
          && seg.segment[1] > seg.segment[0]
          && typeof seg.category === 'string'
        ) {
          const behavior = this.#opts.behavior[seg.category];
          if (behavior !== 'skip' && behavior !== 'seek') {
            continue;
          }
          segments.push({
            start: seg.segment[0],
            end: seg.segment[1],
            category: seg.category,
            mode: behavior === 'skip' ? 'skip' : 'prompt'
          });
        }
      }
      segments.sort((a, b) => a.start - b.start);
    }

    this.#logger.debug(`[sponsorblock] ${segments.length} segment(s) for ${videoId}`);
    if (this.#cache.size >= CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest) {
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(videoId, segments);
    return segments;
  }
}
