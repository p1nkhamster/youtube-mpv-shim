'use strict';

const DEFAULT_PORT = 9909;

async function getPort() {
  const stored = await browser.storage.local.get({ port: DEFAULT_PORT });
  const port = parseInt(stored.port, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

async function postPlay(url, time) {
  const port = await getPort();
  const res = await fetch(`http://127.0.0.1:${port}/api/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, time })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `daemon responded with HTTP ${res.status}`);
  }
}

function flashBadge(ok) {
  browser.browserAction.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
  browser.browserAction.setBadgeText({ text: ok ? '✓' : '✗' });
  setTimeout(() => browser.browserAction.setBadgeText({ text: '' }), 2000);
}

async function castActiveTab(tab) {
  try {
    // grab the page url and current playback position of the visible video
    const results = await browser.tabs.executeScript(tab.id, {
      code: `({
        url: location.href,
        time: (document.querySelector('video') && !isNaN(document.querySelector('video').currentTime))
          ? Math.floor(document.querySelector('video').currentTime) : 0
      })`
    });
    const info = (results && results[0]) || { url: tab.url, time: 0 };
    await postPlay(info.url, info.time);
    // pause in-browser playback now that mpv has taken over
    await browser.tabs.executeScript(tab.id, {
      code: `{ const v = document.querySelector('video'); if (v) v.pause(); }`
    }).catch(() => {});
    flashBadge(true);
  } catch (err) {
    console.error('youtube-mpv-shim:', err);
    flashBadge(false);
  }
}

browser.browserAction.onClicked.addListener((tab) => {
  castActiveTab(tab);
});

browser.contextMenus.create({
  id: 'ytshim-play-link',
  title: 'Play link in mpv',
  contexts: ['link'],
  targetUrlPatterns: [
    '*://www.youtube.com/*',
    '*://youtube.com/*',
    '*://m.youtube.com/*',
    '*://music.youtube.com/*',
    '*://youtu.be/*'
  ]
});

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'ytshim-play-link' || !info.linkUrl) {
    return;
  }
  try {
    await postPlay(info.linkUrl, 0);
    flashBadge(true);
  } catch (err) {
    console.error('youtube-mpv-shim:', err);
    flashBadge(false);
  }
});
