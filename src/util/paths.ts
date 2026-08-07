import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Logger } from 'yt-cast-receiver';

const APP_NAME = 'youtube-mpv-shim';

export function configDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP_NAME);
  }
}

export function defaultSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\youtube-mpv-shim-mpv';
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(runtimeDir, APP_NAME, 'mpv.sock');
}

export function isWindowsPipe(p: string): boolean {
  return p.startsWith('\\\\.\\pipe\\');
}

// state files used to live in ~/.local/state; move them into the config dir
export function migrateLegacyState(logger: Logger): void {
  if (process.platform === 'win32') {
    return;
  }
  const legacyDir = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), APP_NAME);
  if (!fs.existsSync(legacyDir)) {
    return;
  }
  const target = configDir();
  for (const file of ['player-state.json', 'store.json']) {
    const from = path.join(legacyDir, file);
    const to = path.join(target, file);
    if (!fs.existsSync(from) || fs.existsSync(to)) {
      continue;
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      try {
        fs.renameSync(from, to);
      }
      catch {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
      }
      logger.info(`[daemon] migrated ${file} to ${target}`);
    }
    catch (err) {
      logger.warn(`[daemon] could not migrate ${file}:`, err instanceof Error ? err.message : err);
    }
  }
}
