'use strict';

const DEFAULT_PORT = 9909;

async function getPort() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT });
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
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
  chrome.action.setBadgeText({ text: ok ? 'OK' : 'ERR' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

async function castActiveTab(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const video = document.querySelector('video');
        return {
          url: location.href,
          time: video && !isNaN(video.currentTime) ? Math.floor(video.currentTime) : 0
        };
      }
    });
    const info = results?.[0]?.result ?? { url: tab.url, time: 0 };
    await postPlay(info.url, info.time);
    // pause in-browser playback now that mpv has taken over
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const video = document.querySelector('video');
        if (video) video.pause();
      }
    }).catch(() => {});
    flashBadge(true);
  } catch (err) {
    console.error('youtube-mpv-shim:', err);
    flashBadge(false);
  }
}

chrome.action.onClicked.addListener((tab) => {
  castActiveTab(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
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
});

chrome.contextMenus.onClicked.addListener(async (info) => {
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
