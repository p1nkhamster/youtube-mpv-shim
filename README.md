# youtube-mpv-shim

Cast YouTube to a local **mpv** window. A small daemon makes your PC show up as a cast target in YouTube (the same way a smart TV does, via the DIAL protocol and YouTube's Lounge API). Hit the cast button, pick your PC, and the video plays in mpv instead of the browser. Your browser or phone stays connected as a remote: pause, seek, volume, queue and autoplay all work.

For browsers without a working cast button there are companion extensions for both browser families (Firefox/LibreWolf and Chromium/Chrome/Brave/Edge) that send the current video, including your position in it, straight to the daemon.

## Features

- Appears in the YouTube cast menu on the phone app and cast-enabled desktop browsers
- Full remote control from the sender: play/pause, seek, volume, queue, autoplay ("up next")
- In-player menu on the Enter key: recommendations, subtitles, audio tracks, playback speed, quality, Stable Volume, SponsorBlock
- Stable Volume: consistent loudness across videos using YouTube's own per-video loudness data
- SponsorBlock: auto-skips sponsor segments, "seek forward to skip" prompts for intros, outros, self-promo and interaction reminders
- Browser extensions for Firefox-family and Chromium-family browsers
- Settings and player state persist across restarts and updates
- Works on Linux, Windows and macOS

## Requirements

- Node.js >= 18
- mpv (on PATH, or set `mpv.binary` in the config)
- yt-dlp on PATH (keep it current - it is the most common cause of playback breakage: `yt-dlp -U` or your package manager)

## Setup

```sh
npm install -g youtube-mpv-shim
youtube-mpv-shim
```

(Running from source instead: clone the repo, `npm install`, `npm run build`, `node dist/index.js`.)

You should see `"mpv on <hostname>" is discoverable`. Then:

- **Google Chrome / Edge (branded builds):** open youtube.com, play a video, click the cast icon in the player, pick your PC.
- **Phone YouTube app** (same network): pick your PC from the cast menu.
- **Firefox/LibreWolf and plain Chromium:** install the extension (below) and click its toolbar button on any YouTube page. Un-branded Chromium builds (distro packages) usually ship without Google's cast integration, so the in-player cast button never appears there; the extension is the reliable path.

The first cast spawns mpv; closing the mpv window is fine, the next cast respawns it.

## Browser extensions

Both variants do the same: the toolbar button sends the current tab's video to mpv (resuming at your position, pausing the browser player), right-clicking a YouTube link offers *Play link in mpv*, and the options page sets the daemon port (default 9909).

**Firefox / LibreWolf** (Manifest V2): download `ytshim-firefox.xpi` from the [latest release](https://github.com/p1nkhamster/youtube-mpv-shim/releases/latest) and open it with Firefox. It is AMO-signed and installs permanently.

**Chromium / Chrome / Brave / Edge** (Manifest V3): download and extract `ytshim-chromium.zip` from the [latest release](https://github.com/p1nkhamster/youtube-mpv-shim/releases/latest), then load the folder as an unpacked extension on the `chrome://extensions` page (developer mode).

From source instead: the variants live in `extension/firefox/` (load as a temporary add-on on `about:debugging`) and `extension/chromium/` (load unpacked).

The daemon's API binds to `127.0.0.1` and rejects requests from web pages, so only the extensions and local tools can use it:

```sh
curl -X POST http://127.0.0.1:9909/api/play -d '{"url":"https://youtu.be/dQw4w9WgXcQ","time":42}'
curl http://127.0.0.1:9909/api/status
```

## In-player menu

Press **Enter** in the mpv window (arrows navigate, Enter selects, left goes back, Esc closes):

- **Up next / recommendations**: pick a related video to play it
- **Subtitles / Audio track**
- **Playback speed**: 0.25x to 2x
- **Quality**: best down to 360p; reloads the video at the current position
- **Stable Volume**: consistent loudness across videos, using YouTube's own per-video loudness data (realtime `loudnorm` fallback when a video has none). Runs as its own filter; `af=...` from your mpv.conf is untouched.
- **SponsorBlock**: off by default. Sponsor segments auto-skip; self-promo, interaction reminders, intros, outros and previews show a "seek forward to skip" prompt where any forward seek jumps past the segment. Per-category behavior (`"skip"`, `"seek"`, `"none"`) is set via `sponsorBlockBehavior` in the config. Lookups only ever send a 4-character hash prefix, never the video id.

Disable the whole menu with `"menu": false` in the config.

### Theming

The menu is plain text through mpv's native OSD with a background box, selected entry wrapped in `**asterisks**`. It uses your OSD font (`osd-font` in mpv.conf) automatically. While the menu is open three OSD properties are overridden and restored on close; their menu values can be changed in `~/.config/mpv/script-opts/ytshim_menu.conf` (defaults shown):

```ini
back_color=#CC333333     # #AARRGGBB background box color
font_size=40
max_visible_items=10     # long lists scroll around the selection
```

## Configuration

Everything lives in one per-platform folder and survives updates:

- Linux: `~/.config/youtube-mpv-shim/`
- Windows: `%APPDATA%\youtube-mpv-shim\`
- macOS: `~/Library/Application Support/youtube-mpv-shim/`

Files: `config.json` (yours, hand-edited), `player-state.json` (auto-written: volume, mute, speed, quality, Stable Volume and SponsorBlock toggles), `store.json` (cast session identity, so senders remember the device).

`config.json` (all keys optional):

```jsonc
{
  "deviceName": "mpv on mybox",   // name in the cast menu
  "dialPort": 8098,               // DIAL discovery port
  "httpPort": 9909,               // local API for the extensions; 0 disables
  "mpv": {
    "binary": "mpv",
    "extraArgs": [],              // e.g. ["--fs"] for fullscreen
    "socketPath": "..."           // mpv IPC socket/pipe; sensible per-OS default
  },
  "autoplayOnConnect": true,      // YouTube "up next" autoplay
  "menu": true,                   // in-mpv menu on the Enter key
  "persistState": true,           // remember volume/mute/speed/quality/toggles
  "stableVolumeFilter": "lavfi=[loudnorm=I=-14:TP=-1.5:LRA=11]",
  "browserProfile": null,         // daemon youtube cookies: null, "auto" or a profile path
  "sponsorBlockBehavior": {       // per category: "skip", "seek" or "none"
    "sponsor": "skip",
    "selfpromo": "seek",
    "interaction": "seek",
    "intro": "seek",
    "outro": "seek",
    "preview": "seek",
    "music_offtopic": "none",
    "filler": "none"
  },
  "sponsorBlockApiUrl": "https://sponsor.ajay.app",
  "showPairingCode": false,       // log "Link with TV code" codes
  "logLevel": "info"
}
```

A partial `sponsorBlockBehavior` map merges over the defaults. CLI flags override the file: `--name`, `--dial-port`, `--http-port`, `--config`, `--log-level`, `--pairing-code`.

Video quality starts as whatever your mpv.conf says (`ytdl-format=...`). A quality chosen in the menu takes precedence and persists.

**Persistence:** volume, mute, playback speed, the menu quality choice and the Stable Volume / SponsorBlock toggles survive mpv restarts and daemon restarts (`player-state.json`). Set `"persistState": false` to turn this off, or delete the state file to reset.

## YouTube bot check / age-restricted videos

If videos fail to load and the log mentions yt-dlp errors, YouTube is likely bot-checking your IP (very common on VPNs). The fix is to let yt-dlp use your browser's YouTube cookies. Add to `config.json`:

```json
{
  "mpv": {
    "extraArgs": ["--ytdl-raw-options=cookies-from-browser=firefox:/home/you/.config/librewolf/librewolf/<profile-dir>"]
  }
}
```

For actual Firefox, plain `cookies-from-browser=firefox` finds the profile automatically; for Chromium use `cookies-from-browser=chromium`. Putting it here instead of `mpv.conf` keeps the cookie usage scoped to the shim. The same fix covers age-restricted videos.

The daemon's own metadata calls (Stable Volume loudness data in particular; YouTube withholds the player response from bot-checked anonymous requests) can also use cookies, but this is **off by default**: the daemon never reads your browser data unless you opt in via `browserProfile`:

- `"auto"`: reuse the profile from the `cookies-from-browser=firefox:<path>` entry above
- `"/path/to/profile"`: a specific Firefox-family profile directory
- omit the key (or `null`): no cookie usage (default)

Only the essential YouTube auth cookies are read from the profile's `cookies.sqlite`, and requests then count as your account (same as watching in the browser). Without cookies everything still works, with two degradations on bot-checked IPs: Stable Volume falls back to realtime `loudnorm` instead of YouTube's exact per-video gain, and the recommendations menu may occasionally come up empty.

## Credits

- [jellyfin-mpv-shim](https://github.com/jellyfin/jellyfin-mpv-shim) for the inspiration
- [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) for the DIAL + Lounge API receiver implementation
- [SponsorBlock](https://sponsor.ajay.app/) and its community for the segment data
- [youtubei.js](https://github.com/LuanRT/YouTube.js), [mpv](https://mpv.io/) and [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## License

MIT, see [LICENSE](LICENSE).
