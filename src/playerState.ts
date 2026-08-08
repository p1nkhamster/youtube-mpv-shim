import fs from 'fs';
import path from 'path';
import type { Logger } from 'yt-cast-receiver';

export interface PersistedPlayerState {
  volume?: number;
  mute?: boolean;
  speed?: number;
  ytdlFormat?: string;
  stableVolume?: boolean;
  sponsorBlock?: boolean;
  // 'off', a language code, or 'auto:<lang>' for auto-generated captions
  subtitlePref?: string;
}

const TRACKED: Record<string, { key: keyof PersistedPlayerState, valid: (v: unknown) => boolean }> = {
  'volume': { key: 'volume', valid: (v) => typeof v === 'number' && v >= 0 && v <= 1000 },
  'mute': { key: 'mute', valid: (v) => typeof v === 'boolean' },
  'speed': { key: 'speed', valid: (v) => typeof v === 'number' && v > 0 && v <= 100 },
  'ytdl-format': { key: 'ytdlFormat', valid: (v) => typeof v === 'string' && v.length > 0 }
};

const SAVE_DEBOUNCE_MS = 2000;

export default class PlayerStateStore {
  #file: string;
  #state: PersistedPlayerState = {};
  #saveTimer: NodeJS.Timeout | null = null;
  #logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.#file = path.join(dir, 'player-state.json');
    this.#logger = logger;
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as Record<string, unknown>;
      for (const { key, valid } of Object.values(TRACKED)) {
        if (valid(raw[key])) {
          this.#state[key] = raw[key] as never;
        }
      }
      if (typeof raw.stableVolume === 'boolean') {
        this.#state.stableVolume = raw.stableVolume;
      }
      if (typeof raw.sponsorBlock === 'boolean') {
        this.#state.sponsorBlock = raw.sponsorBlock;
      }
      if (typeof raw.subtitlePref === 'string' && raw.subtitlePref) {
        this.#state.subtitlePref = raw.subtitlePref;
      }
      this.#logger.debug('[state] restored player state:', this.#state);
    }
    catch {
      // first run
    }
  }

  get stableVolume(): boolean {
    return this.#state.stableVolume === true;
  }

  setStableVolume(enabled: boolean): void {
    if (this.#state.stableVolume !== enabled) {
      this.#state.stableVolume = enabled;
      this.#scheduleSave();
    }
  }

  get sponsorBlock(): boolean {
    return this.#state.sponsorBlock === true;
  }

  setSponsorBlock(enabled: boolean): void {
    if (this.#state.sponsorBlock !== enabled) {
      this.#state.sponsorBlock = enabled;
      this.#scheduleSave();
    }
  }

  get subtitlePref(): string {
    return this.#state.subtitlePref ?? 'off';
  }

  setSubtitlePref(pref: string): void {
    if (this.#state.subtitlePref !== pref) {
      this.#state.subtitlePref = pref;
      this.#scheduleSave();
    }
  }

  initialProperties(): Record<string, string | number | boolean> {
    const props: Record<string, string | number | boolean> = {};
    for (const [prop, { key, valid }] of Object.entries(TRACKED)) {
      const value = this.#state[key];
      if (value !== undefined && valid(value)) {
        props[prop] = value;
      }
    }
    return props;
  }

  onPropChange(prop: string, value: unknown): void {
    const tracked = TRACKED[prop];
    if (!tracked || !tracked.valid(value) || this.#state[tracked.key] === value) {
      return;
    }
    this.#state[tracked.key] = value as never;
    this.#scheduleSave();
  }

  flush(): void {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      this.#save();
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, SAVE_DEBOUNCE_MS);
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2));
      fs.renameSync(tmp, this.#file);
    }
    catch (err) {
      this.#logger.warn('[state] failed to save player state:', err instanceof Error ? err.message : err);
    }
  }
}
