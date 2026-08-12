[![GitHub release](https://img.shields.io/github/v/release/GuildMastery-io/GuildMasterySync?include_prereleases&label=release)](https://github.com/GuildMastery-io/GuildMasterySync/releases)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Discord](https://img.shields.io/badge/Discord-join-7289DA?logo=discord&logoColor=white)](https://discord.gg/AVRSs9P2Xk)
[![Website](https://img.shields.io/badge/website-guildmastery.io-9B7EDE)](https://www.guildmastery.io)

# GuildMastery Sync

Windows companion app that automatically syncs your [RCLootCouncil_GuildMastery](https://github.com/GuildMastery-io/RCLootCouncil_GuildMastery) addon data to the [GuildMastery](https://www.guildmastery.io) web app.

No more copy-pasting JSON exports. Install the app, point it at your WoW folder, paste your API key, and every `/reload` in-game pushes the latest loot vote sessions to your guild dashboard.

## Features

- **Silent background sync** — watches `WTF/Account/*/SavedVariables/RCLootCouncil_GuildMastery.lua` and uploads on change.
- **Per-account safety** — each WoW account folder is tracked independently; switching characters won't skip a sync.
- **Manual refresh** — one-click resync button if you want to force a push.
- **Connection probe** — live indicator showing whether the server is reachable and the API key is valid (with the guild name displayed when verified).
- **Server-side dedup** — the GuildMastery API rejects exports it already has, so duplicate uploads are harmless.
- **Auto-start with Windows** — optional, toggled in the top bar.
- **Automatic updates** — checks GitHub for a new release on launch and once a day, downloads it silently in the background, then shows a **Restart to install** button. No manual download, no reinstall.
- **Live log panel** — see exactly what the watcher is doing, in real time.

## Install

Grab the latest Windows installer from the [Releases page](https://github.com/GuildMastery-io/GuildMasterySync/releases) and run it.

The installer puts `GuildMastery Sync` in your Start menu. First launch:

1. Click **Parcourir…** and select your `World of Warcraft` folder (the one containing `_retail_` or `_classic_`).
2. Paste your **API key** — generate it from [guildmastery.io](https://www.guildmastery.io) under **Dashboard → API**.
3. Wait for the green **Actif** badge. You're done.

From now on, every time you do `/reload` in-game with the addon loaded, the app catches the file write and pushes the new sessions.

## How it works

```
WoW client (addon writes Lua)
      │
      ▼
SavedVariables/RCLootCouncil_GuildMastery.lua
      │ (chokidar file watcher)
      ▼
GuildMastery Sync (Electron app)
      │ POST /api/loot-sessions  (Bearer <apiKey>)
      ▼
guildmastery.io
```

The app extracts the `syncPayload` field from the addon's SavedVariables, parses it as JSON, hashes it (sha1) to avoid re-uploading identical content, and `POST`s it to the GuildMastery API. The server detects duplicates by `(timestamp, sessions)` and replies with `{ duplicate: true }` if it already knows the payload.

## Automatic updates

The app uses [`electron-updater`](https://www.electron.build/auto-update) against the GitHub Releases feed that `electron-builder` publishes (each release ships the installer plus a `latest.yml` manifest).

- On launch (after ~10s) and every 24h, the app checks for a newer published release.
- If one is found it is downloaded in the background; the top bar then shows a **Restart to install** button (the version badge next to the title also lets you check manually at any time).
- Clicking restart installs the update and relaunches. If you never click it, the update installs the next time you quit the app.

> **Maintainer note:** `electron-updater` only sees **published** GitHub releases. The build config uses `releaseType: draft`, so after `npm run release` you must open the draft release on GitHub and click **Publish** before clients pick it up. The `version` in `package.json` must be bumped for a release to be considered newer.

## Build from source

```bash
git clone https://github.com/GuildMastery-io/GuildMasterySync.git
cd GuildMasterySync
npm install
```

### Development (hot-reload Electron + Vite)

```bash
npm run dev
```

### Production build (Windows installer)

```bash
npm run build
```

Output: `release/GuildMastery Sync Setup <version>.exe`.

## Stack

| Component | Tech |
|---|---|
| Runtime | Electron 41 |
| UI | React 19 + [Mantine 8](https://mantine.dev) + [Tabler Icons](https://tabler.io/icons) |
| Bundler | Vite 8 + `vite-plugin-electron` |
| Installer | `electron-builder` (NSIS) |
| File watcher | [chokidar](https://github.com/paulmillr/chokidar) |
| HTTP client | [axios](https://github.com/axios/axios) |
| Settings store | [electron-store](https://github.com/sindresorhus/electron-store) |

## Project layout

```
GuildMasterySync/
├── electron/
│   ├── main.ts       # BrowserWindow, IPC handlers, auto-sync interval
│   ├── preload.ts    # Named API exposed to the renderer (no generic IPC passthrough)
│   ├── store.ts      # electron-store schema + accessors (apiKey, apiUrl, wowPath, …)
│   └── watcher.ts    # chokidar watch, Lua parser, POST to /api/loot-sessions
├── src/
│   ├── App.tsx       # Main UI (Mantine)
│   ├── main.tsx      # React entrypoint
│   ├── index.css     # Global styles
│   └── vite-env.d.ts # `window.api` type declarations
├── public/logo.png
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tsconfig.node.json
```

## Security notes

- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- The preload exposes a **typed, allowlisted API** — no generic `ipcRenderer.invoke` is reachable from the renderer.
- External navigation is denied; clicks on external URLs are routed through `shell.openExternal`.
- A strict Content-Security-Policy is set in `index.html`.
- The API key is stored locally in `%APPDATA%\guildmasterysync\config.json` via `electron-store`. It is **never** logged. Treat your `%APPDATA%` folder as you would a password file.
- The configured `apiUrl` is validated as `http://` or `https://` before any request — invalid URLs cannot be used to exfiltrate the API key.

## Bug reports & feedback

- Preferred: open an [issue on GitHub](https://github.com/GuildMastery-io/GuildMasterySync/issues)
- Or join the [GuildMastery Discord](https://discord.gg/AVRSs9P2Xk) — `#support` channel is the fastest way to reach us.

When reporting a bug, the **Logs de synchronisation** panel at the bottom of the app is your best friend — copy-paste its contents into the issue.

## License

All rights reserved — see [LICENSE](LICENSE). The source is published for transparency, reference, and bug reporting. Forks, modifications and redistributions require prior written permission.

## Credits

Authored by **Ged** (Uldaman-EU). Built to feed the [GuildMastery](https://www.guildmastery.io) web app from the [RCLootCouncil](https://github.com/evil-morfar/RCLootCouncil2) ecosystem.
