import http from 'http';
import type { Logger } from 'yt-cast-receiver';
import type MpvController from '../mpv/MpvController.js';
import type DirectPlayback from '../playback.js';
import { parseYouTubeUrl } from '../util/youtubeUrl.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface HttpApiOptions {
  port: number;
  mpv: MpvController;
  playback: DirectPlayback;
  logger: Logger;
}

// local api for triggers without a cast button (browser extensions, curl);
// binds 127.0.0.1 only and rejects web-page origins so sites cannot drive it;
// moz-extension:// and chrome-extension:// origins pass the check
export function startHttpApi(opts: HttpApiOptions): Promise<http.Server> {
  const { port, mpv, playback, logger } = opts;

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\//i.test(origin)) {
      sendJson(res, 403, { ok: false, error: 'requests from web pages are not allowed' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        running: mpv.running,
        playing: mpv.hasFile() && !mpv.isPaused(),
        title: mpv.getMediaTitle() ?? null
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/play') {
      void handlePlay(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  async function handlePlay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { url?: unknown, time?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    }
    catch (err) {
      sendJson(res, 400, { ok: false, error: `invalid request body: ${(err as Error).message}` });
      return;
    }
    if (typeof body.url !== 'string') {
      sendJson(res, 400, { ok: false, error: 'missing "url" field' });
      return;
    }

    const parsed = parseYouTubeUrl(body.url);
    if (!parsed) {
      sendJson(res, 400, { ok: false, error: 'not a recognized YouTube URL' });
      return;
    }

    const time = typeof body.time === 'number' && body.time > 0 ? Math.floor(body.time) : parsed.startTime;
    logger.info(`[api] play request: ${parsed.url} at ${time}s`);

    const ok = await playback.play(parsed.url, time, parsed.videoId);
    if (ok) {
      sendJson(res, 200, { ok: true });
    }
    else {
      sendJson(res, 502, { ok: false, error: 'mpv failed to load the video (is yt-dlp installed and up to date?)' });
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      logger.info(`[api] HTTP API listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
