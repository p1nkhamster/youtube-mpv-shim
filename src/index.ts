#!/usr/bin/env node
import { parseArgs } from 'util';
import Daemon from './daemon.js';
import { loadConfig, type Config } from './config.js';

const HELP = `youtube-mpv-shim - cast YouTube to a local mpv

Usage: youtube-mpv-shim [options]

Options:
  -n, --name <name>        Device name shown in the YouTube cast menu
      --dial-port <port>   DIAL discovery server port (default 8098)
      --http-port <port>   Local HTTP API port for the Firefox extension (default 9909, 0 disables)
  -c, --config <file>      Config file (default ~/.config/youtube-mpv-shim/config.json)
      --log-level <level>  error | warn | info | debug (default info)
      --pairing-code       Periodically log a "Link with TV code" pairing code
  -h, --help               Show this help
`;

function main(): void {
  let args;
  try {
    args = parseArgs({
      options: {
        'name': { type: 'string', short: 'n' },
        'dial-port': { type: 'string' },
        'http-port': { type: 'string' },
        'config': { type: 'string', short: 'c' },
        'log-level': { type: 'string' },
        'pairing-code': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' }
      }
    }).values;
  }
  catch (err) {
    console.error((err as Error).message);
    console.error(HELP);
    process.exit(2);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  let cfg: Config;
  try {
    cfg = loadConfig(args.config);
  }
  catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  if (args.name) cfg.deviceName = args.name;
  if (args['dial-port']) cfg.dialPort = parsePort(args['dial-port'], '--dial-port');
  if (args['http-port']) cfg.httpPort = parsePort(args['http-port'], '--http-port');
  if (args['pairing-code']) cfg.showPairingCode = true;
  if (args['log-level']) {
    if (!['error', 'warn', 'info', 'debug', 'none'].includes(args['log-level'])) {
      console.error(`invalid --log-level: ${args['log-level']}`);
      process.exit(2);
    }
    cfg.logLevel = args['log-level'] as Config['logLevel'];
  }

  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });

  const daemon = new Daemon(cfg);

  const shutdown = (): void => {
    daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  daemon.start().catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `port already in use: ${(err as Error).message}\n` +
        'Another instance may be running, or change the port with --dial-port / --http-port.'
      );
    }
    else {
      console.error('failed to start:', err instanceof Error ? (err.stack ?? err.message) : err);
    }
    process.exit(1);
  });
}

function parsePort(value: string, flag: string): number {
  const port = parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid ${flag}: ${value}`);
    process.exit(2);
  }
  return port;
}

main();
