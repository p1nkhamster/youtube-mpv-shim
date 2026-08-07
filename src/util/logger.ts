import type { Logger, LogLevel } from 'yt-cast-receiver';

const LEVEL_ORDER: Record<string, number> = {
  none: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export default class ConsoleLogger implements Logger {
  #level: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.#level = level;
  }

  setLevel(value: LogLevel): void {
    this.#level = value;
  }

  error(...msg: unknown[]): void {
    this.#log('error', ...msg);
  }

  warn(...msg: unknown[]): void {
    this.#log('warn', ...msg);
  }

  info(...msg: unknown[]): void {
    this.#log('info', ...msg);
  }

  debug(...msg: unknown[]): void {
    this.#log('debug', ...msg);
  }

  #log(level: Exclude<LogLevel, 'none'>, ...msg: unknown[]): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.#level]) {
      return;
    }
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = msg
      .map((m) => (m instanceof Error ? (m.stack ?? m.message) : typeof m === 'string' ? m : JSON.stringify(m)))
      .join(' ');
    const out = `${ts} [${level.toUpperCase()}] ${line}`;
    if (level === 'error') {
      console.error(out);
    }
    else if (level === 'warn') {
      console.warn(out);
    }
    else {
      console.log(out);
    }
  }
}
