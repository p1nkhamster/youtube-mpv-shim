import fs from 'fs';
import path from 'path';
import { DataStore } from 'yt-cast-receiver';

// replaces the library default which drops a .node-persist dir into cwd;
// a stable screen id means senders remember this receiver across restarts
export default class JsonFileDataStore extends DataStore {
  #file: string;
  #data: Record<string, unknown> | null = null;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    super();
    this.#file = path.join(dir, 'store.json');
  }

  async set<T>(key: string, value: T): Promise<void> {
    const data = this.#load();
    data[key] = value;
    this.#writeChain = this.#writeChain.then(() => this.#flush(data)).catch((err) => {
      this.logger.error('[datastore] write failed:', err);
    });
    return this.#writeChain;
  }

  async get<T>(key: string): Promise<T | null> {
    const data = this.#load();
    return (data[key] as T | undefined) ?? null;
  }

  #load(): Record<string, unknown> {
    if (this.#data) {
      return this.#data;
    }
    try {
      this.#data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    }
    catch {
      this.#data = {};
    }
    return this.#data as Record<string, unknown>;
  }

  async #flush(data: Record<string, unknown>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmp, this.#file);
  }
}
