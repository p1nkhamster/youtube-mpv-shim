'use strict';

const portInput = document.getElementById('port');
const savedNote = document.getElementById('saved');

browser.storage.local.get({ port: 9909 }).then((stored) => {
  portInput.value = stored.port;
});

document.getElementById('save').addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    portInput.value = 9909;
    return;
  }
  await browser.storage.local.set({ port });
  savedNote.style.visibility = 'visible';
  setTimeout(() => { savedNote.style.visibility = 'hidden'; }, 1500);
});
