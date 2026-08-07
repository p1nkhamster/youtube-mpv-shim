import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Logger } from 'yt-cast-receiver';

// only the cookies youtube auth needs; sending everything the browser has
// for youtube.com blows past http/2 header limits
const ESSENTIAL_COOKIES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  'LOGIN_INFO', 'VISITOR_INFO1_LIVE', 'PREF', 'YSC'
];

// reads youtube auth cookies from a firefox-family profile as a cookie
// header string; the db is copied first because the browser keeps it locked
export function loadYouTubeCookies(profileDir: string, logger: Logger): string | null {
  const src = path.join(profileDir, 'cookies.sqlite');
  if (!fs.existsSync(src)) {
    logger.warn(`[cookies] no cookies.sqlite in ${profileDir}`);
    return null;
  }
  const tmpBase = path.join(os.tmpdir(), `ytshim-cookies-${process.pid}`);
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + ext)) {
        fs.copyFileSync(src + ext, tmpBase + ext);
      }
    }
    const db = new DatabaseSync(tmpBase, { readOnly: true });
    let rows: Array<{ name: string, value: string, host: string }>;
    try {
      rows = db.prepare(
        "SELECT name, value, host FROM moz_cookies WHERE host LIKE '%youtube.com' AND expiry > ?"
      ).all(Math.floor(Date.now() / 1000)) as never;
    }
    finally {
      db.close();
    }
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (ESSENTIAL_COOKIES.includes(row.name) && (!seen.has(row.name) || row.host === '.youtube.com')) {
        seen.set(row.name, row.value);
      }
    }
    if (seen.size === 0) {
      logger.warn(`[cookies] no YouTube cookies found in ${profileDir} - not signed in?`);
      return null;
    }
    logger.debug(`[cookies] loaded ${seen.size} YouTube cookies from browser profile`);
    return [...seen.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  catch (err) {
    logger.warn('[cookies] failed to read browser cookies:', err instanceof Error ? err.message : err);
    return null;
  }
  finally {
    for (const ext of ['', '-wal', '-shm']) {
      fs.rmSync(tmpBase + ext, { force: true });
    }
  }
}

// reuse the profile the user already configured for mpv via
// --ytdl-raw-options=cookies-from-browser=firefox:/path/to/profile
export function profileFromMpvArgs(extraArgs: string[]): string | null {
  for (const arg of extraArgs) {
    const m = /cookies-from-browser=firefox:([^,]+)/.exec(arg);
    if (m && fs.existsSync(m[1])) {
      return m[1];
    }
  }
  return null;
}
