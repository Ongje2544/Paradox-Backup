# Paradox Backup

Windows desktop app (Electron) that checks backup folders on each machine and warns when a backup disk is nearly full. UI text is Thai.

## What it does
- Each source = machine name + folder path (local `D:\Backup` or UNC `\\10.0.0.250\E$\Backup`).
- Counts files by modified time into two daily rounds: noon (11:00–15:00) and evening (20:00–23:59). Both windows include their last minute and can be changed in Settings.
- Dashboard: noon / evening / total cards (file count, GB, difference vs the previous day in GB and %), a per-machine table with status, and a 14-day strip for picking a day (←/→ keys, a "today" button, and a date picker for older days).
- Disk page: used/free/total for each backup drive (one entry per unique drive).
- Runs in the background from the system tray. Closing the window destroys it to free memory. Sends Windows notifications when a drive has less free space than `warn_free_gb` (default 10 GB), is above `warn_used_pct` (default 90%), or can't be reached. Re-notifies every 6 h while the problem lasts. Starts at login with `--hidden` (installed build only).

## Layout
- `main.js` – main process: config (`%APPDATA%/Paradox Backup/config.json`), scanning, disk checks, tray, notifications, IPC.
- `scan-core.js` – `scanRange()`: one recursive walk per source that buckets files by day and round. It runs inside a `worker_threads` eval worker, so it must stay self-contained (no outer variables).
- `preload.js` – exposes `window.paradox` to the renderer.
- `renderer/` – `index.html`, `style.css` (sky-blue → indigo theme, CSS variables at the top), `app.js`.
- `assets/` – `icon.png`, `icon.ico` (hard disk + magnifier + cloud), `tray.png`, `tray-alert.png`.
- `scripts/after-pack.js` – sets the exe icon and version info with `resedit`. Code signing (`signAndEditExecutable`) is off so building needs neither admin rights nor symlink privileges.

## Commands
- `npm install`
- `npm start` – run in dev
- `npm run dist` – builds `dist/ParadoxBackup-Setup-<version>.exe` (NSIS, x64)
- `build.bat` / `run-dev.bat` – double-click wrappers. Keep `.bat` files ASCII-only with CRLF line endings, because cmd breaks on Thai/UTF-8 and LF.

## Notes
- The user's first backup source is `\\10.0.0.250\E$\Backup` (drive E: on 10.0.0.250).
- The UI style was inspired by the "Mystic Paradox" launcher look: dark glass panels, glow, starfield, animated borders.
