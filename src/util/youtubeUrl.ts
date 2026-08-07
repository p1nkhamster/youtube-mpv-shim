export interface ParsedYouTubeUrl {
  videoId?: string;
  playlistId?: string;
  startTime: number;
  url: string;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,}$/;

// parses "1h2m3s", "90s" or plain "90" into seconds
function parseTimeParam(value: string | null): number {
  if (!value) {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    return 0;
  }
  return (parseInt(m[1] ?? '0', 10) * 3600) + (parseInt(m[2] ?? '0', 10) * 60) + parseInt(m[3] ?? '0', 10);
}

// returns a canonical mpv url for the common youtube url shapes,
// null for anything that is not a youtube video/playlist url
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  let u: URL;
  try {
    u = new URL(input);
  }
  catch {
    return null;
  }

  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (!['youtube.com', 'youtu.be', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
    return null;
  }

  let videoId: string | undefined;
  const startTime = parseTimeParam(u.searchParams.get('t') ?? u.searchParams.get('start'));
  const listParam = u.searchParams.get('list');
  const playlistId = listParam && PLAYLIST_ID_RE.test(listParam) ? listParam : undefined;

  if (host === 'youtu.be') {
    videoId = u.pathname.slice(1).split('/')[0];
  }
  else if (u.pathname === '/watch') {
    videoId = u.searchParams.get('v') ?? undefined;
  }
  else {
    const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    if (m) {
      videoId = m[1];
    }
  }

  if (videoId && !VIDEO_ID_RE.test(videoId)) {
    videoId = undefined;
  }

  if (videoId) {
    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', videoId);
    return { videoId, playlistId, startTime, url: url.toString() };
  }

  if (playlistId && (u.pathname === '/playlist' || u.pathname === '/watch')) {
    return { playlistId, startTime: 0, url: `https://www.youtube.com/playlist?list=${playlistId}` };
  }

  return null;
}

export function watchUrlFromVideoId(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
