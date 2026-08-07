import EventEmitter from 'events';
import net from 'net';
import type { Logger } from 'yt-cast-receiver';

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

export interface MpvEvent {
  event: string;
  [key: string]: unknown;
}

// mpv json ipc: newline-delimited json, responses correlated via request_id
export default class MpvIpcClient extends EventEmitter {
  #socket: net.Socket | null = null;
  #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #buffer = '';
  #logger: Logger;

  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.#socket = socket;
        resolve();
      });
      socket.once('error', (err) => {
        if (this.#socket !== socket) {
          reject(err);
          return;
        }
        this.#logger.debug('[mpv-ipc] socket error:', err.message);
      });
      socket.on('data', (chunk: string) => this.#onData(chunk));
      socket.on('close', () => {
        if (this.#socket === socket) {
          this.#teardown();
          this.emit('close');
        }
      });
    });
  }

  disconnect(): void {
    const socket = this.#socket;
    this.#teardown();
    socket?.destroy();
  }

  send(command: unknown[]): Promise<unknown> {
    if (!this.#socket) {
      return Promise.reject(new Error('mpv IPC socket not connected'));
    }
    const requestId = this.#nextRequestId++;
    const payload = `${JSON.stringify({ command, request_id: requestId })}\n`;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#socket?.write(payload, (err) => {
        if (err && this.#pending.delete(requestId)) {
          reject(err);
        }
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      }
      catch {
        this.#logger.debug('[mpv-ipc] unparseable line:', line);
        continue;
      }
      if (typeof msg.request_id === 'number' && msg.event === undefined) {
        const pending = this.#pending.get(msg.request_id);
        if (pending) {
          this.#pending.delete(msg.request_id);
          if (msg.error === 'success') {
            pending.resolve(msg.data);
          }
          else {
            pending.reject(new Error(`mpv: ${String(msg.error)}`));
          }
        }
      }
      else if (typeof msg.event === 'string') {
        this.emit('mpv-event', msg as unknown as MpvEvent);
      }
    }
  }

  #teardown(): void {
    this.#socket = null;
    this.#buffer = '';
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      p.reject(new Error('mpv IPC socket closed'));
    }
  }
}
