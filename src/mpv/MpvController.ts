import { spawn, type ChildProcess } from 'child_process';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import type { Logger } from 'yt-cast-receiver';
import { isWindowsPipe } from '../util/paths.js';
import MpvIpcClient, { type MpvEvent } from './MpvIpcClient.js';

export interface MpvControllerOptions {
  binary: string;
  extraArgs: string[];
  socketPath: string;
  menuScriptPath?: string;
  initialProperties?: () => Record<string, string | number | boolean>;
}

const OBSERVED_PROPS = ['pause', 'time-pos', 'duration', 'volume', 'mute', 'idle-active', 'media-title', 'path', 'speed', 'ytdl-format'] as const;

// props reported as external changes when not caused by our own commands
const EXTERNAL_NOTIFY_PROPS = new Set(['pause', 'volume', 'mute']);

const LOAD_TIMEOUT_MS = 60_000;

interface PendingLoad {
  resolve: (success: boolean) => void;
  timer: NodeJS.Timeout;
}

interface Expectation {
  value: unknown;
  expires: number;
}

// owns the mpv process and its ipc socket
// events: ended(reason), external-prop-change(name, value), prop-change(name, value),
//         file-loaded, client-message(args), ready, exited
export default class MpvController extends EventEmitter {
  #opts: MpvControllerOptions;
  #logger: Logger;
  #child: ChildProcess | null = null;
  #ipc: MpvIpcClient | null = null;
  #starting: Promise<void> | null = null;
  #props = new Map<string, unknown>();
  #initialSeen = new Set<string>();
  #expected = new Map<string, Expectation[]>();
  #pendingLoad: PendingLoad | null = null;

  constructor(opts: MpvControllerOptions, logger: Logger) {
    super();
    this.#opts = opts;
    this.#logger = logger;
  }

  get running(): boolean {
    return this.#child !== null && this.#ipc !== null && this.#ipc.connected;
  }

  getCachedProp(name: string): unknown {
    return this.#props.get(name);
  }

  async ensureRunning(): Promise<void> {
    if (this.running) {
      return;
    }
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null;
      });
    }
    return this.#starting;
  }

  async #start(): Promise<void> {
    if (!isWindowsPipe(this.#opts.socketPath)) {
      fs.mkdirSync(path.dirname(this.#opts.socketPath), { recursive: true, mode: 0o700 });
      fs.rmSync(this.#opts.socketPath, { force: true });
    }

    const args = [
      `--input-ipc-server=${this.#opts.socketPath}`,
      '--idle=yes',
      '--keep-open=no',
      '--no-terminal',
      '--ytdl=yes',
      ...(this.#opts.menuScriptPath ? [`--script=${this.#opts.menuScriptPath}`] : []),
      ...this.#opts.extraArgs
    ];
    this.#logger.info(`[mpv] spawning: ${this.#opts.binary} ${args.join(' ')}`);
    const child = spawn(this.#opts.binary, args, { stdio: 'ignore' });
    this.#child = child;

    child.on('error', (err) => {
      this.#logger.error('[mpv] failed to spawn:', err.message);
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) {
        return;
      }
      this.#logger.info(`[mpv] process exited (code=${code}, signal=${signal})`);
      this.#cleanup();
      this.emit('exited');
    });

    const ipc = new MpvIpcClient(this.#logger);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (this.#child !== child || child.exitCode !== null) {
        throw new Error('mpv exited before the IPC socket became available');
      }
      try {
        await ipc.connect(this.#opts.socketPath);
        break;
      }
      catch {
        if (Date.now() > deadline) {
          child.kill('SIGTERM');
          throw new Error('timed out waiting for mpv IPC socket');
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    this.#ipc = ipc;
    ipc.on('mpv-event', (evt: MpvEvent) => this.#onMpvEvent(evt));
    ipc.on('close', () => {
      if (this.#ipc === ipc && this.#child) {
        this.#logger.warn('[mpv] IPC socket closed unexpectedly; terminating mpv');
        const c = this.#child;
        this.#cleanup();
        c.kill('SIGTERM');
        this.emit('exited');
      }
    });

    // restore persisted settings before observers register so the initial
    // observe events already carry restored values
    const initialProps = this.#opts.initialProperties?.() ?? {};
    for (const [prop, value] of Object.entries(initialProps)) {
      try {
        await ipc.send(['set_property', prop, value]);
      }
      catch (err) {
        this.#logger.debug(`[mpv] could not restore ${prop}:`, err instanceof Error ? err.message : err);
      }
    }

    let id = 1;
    for (const prop of OBSERVED_PROPS) {
      await ipc.send(['observe_property', id++, prop]);
    }
    this.#logger.info('[mpv] ready (IPC connected)');
    this.emit('ready');
  }

  // resolves true on file-loaded, false on load failure or timeout
  async load(url: string, start = 0): Promise<boolean> {
    await this.ensureRunning();
    const ipc = this.#ipc;
    if (!ipc) {
      return false;
    }

    this.#cancelPendingLoad();

    // register the waiter before loadfile so events cannot race past it
    const loadedPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pendingLoad?.resolve === resolve) {
          this.#pendingLoad = null;
        }
        this.#logger.error(`[mpv] timed out loading ${url}`);
        resolve(false);
      }, LOAD_TIMEOUT_MS);
      this.#pendingLoad = { resolve, timer };
    });

    try {
      if (start > 0) {
        try {
          // mpv >= 0.38 loadfile has an index arg before options
          await ipc.send(['loadfile', url, 'replace', -1, `start=${start}`]);
        }
        catch {
          await ipc.send(['loadfile', url, 'replace', `start=${start}`]);
        }
      }
      else {
        await ipc.send(['loadfile', url, 'replace']);
      }
    }
    catch (err) {
      this.#logger.error('[mpv] loadfile failed:', err instanceof Error ? err.message : err);
      this.#cancelPendingLoad();
      return false;
    }

    const loaded = await loadedPromise;

    if (loaded) {
      // pause is sticky across files; a freshly cast video must play
      await this.setPause(false).catch(() => undefined);
    }
    return loaded;
  }

  async setPause(paused: boolean): Promise<void> {
    this.#expect('pause', paused);
    await this.#send(['set_property', 'pause', paused]);
  }

  async seekAbsolute(position: number): Promise<void> {
    await this.#send(['seek', position, 'absolute']);
  }

  async stop(): Promise<void> {
    this.#cancelPendingLoad();
    await this.#send(['stop']);
  }

  async setVolume(level: number, muted: boolean): Promise<void> {
    this.#expect('volume', level);
    this.#expect('mute', muted);
    await this.#send(['set_property', 'volume', level]);
    await this.#send(['set_property', 'mute', muted]);
  }

  getVolume(): { level: number; muted: boolean } {
    const raw = this.#props.get('volume');
    const level = typeof raw === 'number' ? Math.max(0, Math.min(100, Math.round(raw))) : 100;
    return { level, muted: this.#props.get('mute') === true };
  }

  getPosition(): number {
    const pos = this.#props.get('time-pos');
    return typeof pos === 'number' && pos >= 0 ? pos : 0;
  }

  getDuration(): number {
    const dur = this.#props.get('duration');
    return typeof dur === 'number' && dur >= 0 ? dur : 0;
  }

  getMediaTitle(): string | undefined {
    const title = this.#props.get('media-title');
    return typeof title === 'string' && title ? title : undefined;
  }

  getPath(): string | undefined {
    const p = this.#props.get('path');
    return typeof p === 'string' && p ? p : undefined;
  }

  // direct query; the observed-property cache can lag behind file-loaded
  async queryPath(): Promise<string | undefined> {
    try {
      const p = await this.#send(['get_property', 'path']);
      return typeof p === 'string' && p ? p : undefined;
    }
    catch {
      return undefined;
    }
  }

  // labeled add/remove leaves user filters from mpv.conf untouched
  async setAudioFilterEnabled(label: string, filter: string, enabled: boolean): Promise<void> {
    try {
      await this.#send(['af', 'remove', `@${label}`]);
    }
    catch {
      // not present
    }
    if (enabled) {
      await this.#send(['af', 'add', `@${label}:${filter}`]);
    }
  }

  async hasAudioFilter(label: string): Promise<boolean> {
    try {
      const af = await this.#send(['get_property', 'af']);
      return Array.isArray(af) && af.some((f) => (f as { label?: string })?.label === label);
    }
    catch {
      return false;
    }
  }

  sendScriptMessage(scriptName: string, ...args: string[]): void {
    this.#send(['script-message-to', scriptName, ...args]).catch((err: unknown) => {
      this.#logger.debug('[mpv] script-message-to failed:', err instanceof Error ? err.message : err);
    });
  }

  isPaused(): boolean {
    return this.#props.get('pause') === true;
  }

  hasFile(): boolean {
    return this.running && this.#props.get('idle-active') === false;
  }

  async shutdown(): Promise<void> {
    const child = this.#child;
    const ipc = this.#ipc;
    this.#child = null; // suppress the exited event during deliberate shutdown
    if (ipc?.connected) {
      await Promise.race([
        ipc.send(['quit']).catch(() => undefined),
        new Promise((r) => setTimeout(r, 500))
      ]);
    }
    ipc?.disconnect();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
    }
    this.#cleanup();
  }

  #send(command: unknown[]): Promise<unknown> {
    if (!this.#ipc) {
      return Promise.reject(new Error('mpv is not running'));
    }
    return this.#ipc.send(command);
  }

  #onMpvEvent(evt: MpvEvent): void {
    switch (evt.event) {
      case 'property-change': {
        const name = String(evt.name);
        const value = evt.data;
        this.#props.set(name, value);
        this.emit('prop-change', name, value);
        if (!EXTERNAL_NOTIFY_PROPS.has(name)) {
          return;
        }
        // first event after observe_property just reports the current value
        if (!this.#initialSeen.has(name)) {
          this.#initialSeen.add(name);
          return;
        }
        if (this.#consumeExpectation(name, value)) {
          return;
        }
        this.emit('external-prop-change', name, value);
        break;
      }
      case 'file-loaded': {
        if (this.#pendingLoad) {
          const { resolve, timer } = this.#pendingLoad;
          this.#pendingLoad = null;
          clearTimeout(timer);
          resolve(true);
        }
        this.emit('file-loaded');
        break;
      }
      case 'client-message': {
        if (Array.isArray(evt.args)) {
          this.emit('client-message', evt.args.map(String));
        }
        break;
      }
      case 'end-file': {
        const reason = typeof evt.reason === 'string' ? evt.reason : 'unknown';
        if (this.#pendingLoad && reason === 'error') {
          const { resolve, timer } = this.#pendingLoad;
          this.#pendingLoad = null;
          clearTimeout(timer);
          resolve(false);
        }
        else if (!this.#pendingLoad && reason !== 'redirect') {
          this.emit('ended', reason);
        }
        break;
      }
      default:
        break;
    }
  }

  #expect(name: string, value: unknown): void {
    const list = this.#expected.get(name) ?? [];
    list.push({ value, expires: Date.now() + 3000 });
    this.#expected.set(name, list);
  }

  #consumeExpectation(name: string, value: unknown): boolean {
    const list = this.#expected.get(name);
    if (!list) {
      return false;
    }
    const now = Date.now();
    while (list.length) {
      const exp = list.shift() as Expectation;
      if (exp.expires < now) {
        continue;
      }
      const matches = typeof exp.value === 'number' && typeof value === 'number'
        ? Math.abs(exp.value - value) < 0.5
        : exp.value === value;
      if (matches) {
        return true;
      }
    }
    this.#expected.delete(name);
    return false;
  }

  #cancelPendingLoad(): void {
    if (this.#pendingLoad) {
      const { resolve, timer } = this.#pendingLoad;
      this.#pendingLoad = null;
      clearTimeout(timer);
      resolve(false);
    }
  }

  #cleanup(): void {
    this.#child = null;
    this.#ipc?.removeAllListeners();
    this.#ipc?.disconnect();
    this.#ipc = null;
    this.#props.clear();
    this.#initialSeen.clear();
    this.#expected.clear();
    this.#cancelPendingLoad();
  }
}
