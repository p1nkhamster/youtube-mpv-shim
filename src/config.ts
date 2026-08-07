import fs from 'fs';
import os from 'os';
import path from 'path';
import { configDir, defaultSocketPath } from './util/paths.js';

export type SponsorBehavior = 'none' | 'seek' | 'skip';

export interface Config {
  deviceName: string;
  dialPort: number;
  httpPort: number;
  mpv: {
    binary: string;
    extraArgs: string[];
    socketPath: string;
  };
  autoplayOnConnect: boolean;
  menu: boolean;
  persistState: boolean;
  stableVolumeFilter: string;
  // youtube cookies for the daemon's metadata calls; off by default.
  // null = off, 'auto' = detect from cookies-from-browser in mpv.extraArgs,
  // or a firefox-family profile directory path
  browserProfile: string | null;
  // per category: skip = auto-skip, seek = seek-to-skip prompt, none = ignore
  sponsorBlockBehavior: Record<string, SponsorBehavior>;
  sponsorBlockApiUrl: string;
  showPairingCode: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'none';
}

export function defaultConfig(): Config {
  return {
    deviceName: `mpv on ${os.hostname()}`,
    dialPort: 8098,
    httpPort: 9909,
    mpv: {
      binary: 'mpv',
      extraArgs: [],
      socketPath: defaultSocketPath()
    },
    autoplayOnConnect: true,
    menu: true,
    persistState: true,
    stableVolumeFilter: 'lavfi=[loudnorm=I=-14:TP=-1.5:LRA=11]',
    browserProfile: null,
    sponsorBlockBehavior: {
      sponsor: 'skip',
      selfpromo: 'seek',
      interaction: 'seek',
      intro: 'seek',
      outro: 'seek',
      preview: 'seek',
      music_offtopic: 'none',
      filler: 'none'
    },
    sponsorBlockApiUrl: 'https://sponsor.ajay.app',
    showPairingCode: false,
    logLevel: 'info'
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function loadConfig(configPath?: string): Config {
  const file = configPath ?? path.join(configDir(), 'config.json');
  const cfg = defaultConfig();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !configPath) {
      return cfg;
    }
    throw new Error(`cannot read config file ${file}: ${(err as Error).message}`);
  }

  let user: Record<string, unknown>;
  try {
    user = JSON.parse(raw);
  }
  catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof user.deviceName === 'string') cfg.deviceName = user.deviceName;
  if (typeof user.dialPort === 'number') cfg.dialPort = user.dialPort;
  if (typeof user.httpPort === 'number') cfg.httpPort = user.httpPort;
  if (typeof user.autoplayOnConnect === 'boolean') cfg.autoplayOnConnect = user.autoplayOnConnect;
  if (typeof user.menu === 'boolean') cfg.menu = user.menu;
  if (typeof user.persistState === 'boolean') cfg.persistState = user.persistState;
  if (typeof user.stableVolumeFilter === 'string' && user.stableVolumeFilter) cfg.stableVolumeFilter = user.stableVolumeFilter;
  if (typeof user.browserProfile === 'string') cfg.browserProfile = user.browserProfile;
  if (user.sponsorBlockBehavior && typeof user.sponsorBlockBehavior === 'object') {
    for (const [category, behavior] of Object.entries(user.sponsorBlockBehavior as Record<string, unknown>)) {
      if (behavior === 'none' || behavior === 'seek' || behavior === 'skip') {
        cfg.sponsorBlockBehavior[category] = behavior;
      }
    }
  }
  if (typeof user.sponsorBlockApiUrl === 'string' && user.sponsorBlockApiUrl) cfg.sponsorBlockApiUrl = user.sponsorBlockApiUrl.replace(/\/$/, '');
  if (typeof user.showPairingCode === 'boolean') cfg.showPairingCode = user.showPairingCode;
  if (typeof user.logLevel === 'string' && ['error', 'warn', 'info', 'debug', 'none'].includes(user.logLevel)) {
    cfg.logLevel = user.logLevel as Config['logLevel'];
  }
  if (user.mpv && typeof user.mpv === 'object') {
    const mpv = user.mpv as Record<string, unknown>;
    if (typeof mpv.binary === 'string') cfg.mpv.binary = mpv.binary;
    if (isStringArray(mpv.extraArgs)) cfg.mpv.extraArgs = mpv.extraArgs;
    if (typeof mpv.socketPath === 'string') cfg.mpv.socketPath = mpv.socketPath;
  }
  return cfg;
}
