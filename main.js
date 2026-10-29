'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { scanRange } = require('./scan-core');

const APP_ID = 'com.paradox.backup';
const GB = 1024 ** 3;
const STRIP_DAYS = 14;                     // จำนวนวันในแถบเลือกวัน
const CACHE_MS = 3 * 60 * 1000;            // เก็บผลสแกนไว้ 3 นาที เปลี่ยนวันได้ทันที
const RENOTIFY_MS = 6 * 60 * 60 * 1000;    // แจ้งซ้ำทุก 6 ชม. ถ้าดิสก์ยังเต็มอยู่
const DEFAULT_CFG = {
  sources: [],                             // [{machine, path}]
  noon: ['11:00', '15:00'],
  evening: ['20:00', '23:59'],
  refresh_min: 10,
  warn_free_gb: 10,
  warn_used_pct: 90,
  autostart: true,
  tray_hint_shown: false,
};
const WORKER_CODE =
  "const { parentPort, workerData } = require('worker_threads');\n" +
  'const scanRange = ' + scanRange.toString() + ';\n' +
  'parentPort.postMessage(scanRange(workerData));';

let win = null;
let tray = null;
let quitting = false;
let checkTimer = null;
const alertState = new Map();
const scanCache = new Map();
const liveNotes = [];

app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ---------------- helpers ----------------
const assetPath = (f) => path.join(__dirname, 'assets', f);
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const pad = (n) => String(n).padStart(2, '0');
const localDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + n));
}
const fmtGB = (b) => (b / GB).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const driveLabel = (p) => path.win32.parse(p).root.replace(/[\\/]+$/, '') || p;
const zero = () => ({ noon: [0, 0], evening: [0, 0] });

function loadCfg() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath(), 'utf8')));
  } catch (e) { /* ใช้ค่าเริ่มต้น */ }
  return cfg;
}

function saveCfg(cfg) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function hm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error('bad time');
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) throw new Error('bad time');
  return h * 3600 + mi * 60;
}

// ---------------- disk space ----------------
function psDiskInfo(p) {
  const script = [
    "$sig='[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode)] public static extern bool GetDiskFreeSpaceEx(string d,out ulong a,out ulong t,out ulong f);'",
    '$T=Add-Type -MemberDefinition $sig -Name Disk -Namespace Pxb -PassThru',
    '[uint64]$a=0;[uint64]$t=0;[uint64]$f=0',
    'if($T::GetDiskFreeSpaceEx($env:PXB_PATH,[ref]$a,[ref]$t,[ref]$f)){"$a $t $f"}',
  ].join('\n');
  const target = /[\\/]$/.test(p) ? p : p + '\\';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, PXB_PATH: target }, timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const [a, t] = String(stdout).trim().split(/\s+/).map(Number);
        if (!t) return resolve(null);
        resolve({ total: t, free: a, used: t - a });
      });
  });
}

async function diskInfo(p) {
  try {
    const s = await fs.promises.statfs(p);
    const bs = Number(s.bsize);
    const total = Number(s.blocks) * bs;
    const free = Number(s.bavail) * bs;
    if (total > 0) return { total, free, used: total - free };
  } catch (e) { /* ลองวิธีสำรอง */ }
  return process.platform === 'win32' ? psDiskInfo(p) : null;
}

// ---------------- scanning ----------------
function runScan(job) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(WORKER_CODE, { eval: true, workerData: job });
    } catch (e) {
      return resolve({ error: 'เริ่มสแกนไม่ได้' });
    }
    w.once('message', resolve);
    w.once('error', (e) => resolve({ error: String(e.message || e) }));
    w.once('exit', () => resolve({ error: 'การสแกนหยุดกลางคัน' }));
  });
}

async function scanCached(job, force) {
  const key = JSON.stringify(job);
  const hit = scanCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = await runScan(job);
  scanCache.set(key, { at: Date.now(), result });
  if (scanCache.size > 64) scanCache.delete(scanCache.keys().next().value);
  return result;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function collect(day, force) {
  const cfg = loadCfg();
  const winSec = {};
  for (const r of ['noon', 'evening']) winSec[r] = [hm(cfg[r][0]), hm(cfg[r][1]) + 60];

  const now = new Date();
  const today = localDateStr(now);
  if (day > today) day = today;
  // แถบวัน: 14 วันล่าสุด ถ้าเลือกวันเก่ากว่านั้น แถบจะเลื่อนไปจบที่วันที่เลือก
  const stripEnd = day >= addDays(today, -(STRIP_DAYS - 1)) ? today : day;
  const stripStart = addDays(stripEnd, -(STRIP_DAYS - 1));
  const from = addDays(stripStart, -1);     // รวมวันก่อนหน้าเพื่อเทียบ "เมื่อวาน"
  const prevDay = addDays(day, -1);

  const sources = await mapLimit(cfg.sources, 4, async (src) => {
    const [scan, disk] = await Promise.all([
      scanCached({ root: src.path, from, to: stripEnd, win: winSec }, force),
      diskInfo(src.path),
    ]);
    const days = scan.days || {};
    return {
      machine: src.machine,
      path: src.path,
      drive: driveLabel(src.path),
      error: scan.error || null,
      cur: days[day] || zero(),
      prev: days[prevDay] || zero(),
      days,
      disk,
    };
  });

  const strip = [];
  for (let i = 0; i < STRIP_DAYS; i++) {
    const date = addDays(stripStart, i);
    const e = { date, noon: [0, 0], evening: [0, 0], noonOk: 0, eveOk: 0 };
    for (const s of sources) {
      const d = s.days[date];
      if (!d) continue;
      e.noon[0] += d.noon[0]; e.noon[1] += d.noon[1];
      e.evening[0] += d.evening[0]; e.evening[1] += d.evening[1];
      if (d.noon[0] > 0) e.noonOk++;
      if (d.evening[0] > 0) e.eveOk++;
    }
    strip.push(e);
  }
  for (const s of sources) delete s.days;

  return {
    day,
    today,
    is_today: day === today,
    now_sec: now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
    windows: { noon: cfg.noon, evening: cfg.evening },
    win_sec: winSec,
    refresh_min: cfg.refresh_min,
    warn: { free_gb: cfg.warn_free_gb, used_pct: cfg.warn_used_pct },
    n: sources.filter((s) => !s.error).length,
    strip,
    sources,
  };
}

// ---------------- background disk watcher ----------------
function lowReason(info, cfg) {
  if (!info) return null;
  const pct = info.total ? (info.used / info.total) * 100 : 0;
  if (info.free < cfg.warn_free_gb * GB) return `เหลือพื้นที่ว่างเพียง ${fmtGB(info.free)} GB (ต่ำกว่า ${cfg.warn_free_gb} GB)`;
  if (pct >= cfg.warn_used_pct) return `ใช้ไปแล้ว ${pct.toFixed(1)}% (ว่าง ${fmtGB(info.free)} GB)`;
  return null;
}

function notify(title, body, page) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: nativeImage.createFromPath(assetPath('icon.png')) });
  n.on('click', () => showWindow(page || 'disk'));
  liveNotes.push(n);
  if (liveNotes.length > 20) liveNotes.shift();
  n.show();
}

async function checkDisks() {
  const cfg = loadCfg();
  const seen = new Set();
  let problems = 0;
  const now = Date.now();
  for (const s of cfg.sources) {
    const key = driveLabel(s.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = await diskInfo(s.path);
    let msg, title;
    if (!info) {
      msg = 'อ่านพื้นที่ดิสก์ไม่ได้ (เครื่องปิดอยู่หรือ path เข้าไม่ได้)';
      title = `⚠ เข้าถึง ${s.machine} ไม่ได้`;
    } else {
      msg = lowReason(info, cfg);
      title = `⚠ ดิสก์ใกล้เต็ม: ${s.machine} (${driveLabel(s.path)})`;
    }
    if (!msg) {
      alertState.delete(key);
      continue;
    }
    problems++;
    const st = alertState.get(key);
    if (!st || now - st.at > RENOTIFY_MS) {
      alertState.set(key, { at: now });
      notify(title, msg, 'disk');
    }
  }
  updateTray(problems);
}

function scheduleChecks() {
  if (checkTimer) clearInterval(checkTimer);
  const min = Math.max(1, Number(loadCfg().refresh_min) || 10);
  checkTimer = setInterval(() => checkDisks().catch(() => {}), min * 60 * 1000);
}

// ---------------- window & tray ----------------
// ปิดหน้าต่าง = ทำลายหน้าต่างทิ้งเพื่อคืนหน่วยความจำ เหลือแค่ตัวเฝ้าระวังเล็กๆ ที่ถาดระบบ
function createWindow(page) {
  win = new BrowserWindow({
    width: 1260,
    height: 800,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#050a18',
    title: 'Paradox Backup',
    icon: nativeImage.createFromPath(assetPath('icon.png')),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#050a18', symbolColor: '#4cc9f0', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { page: page || 'dash' } });
  win.once('ready-to-show', () => win && win.show());
  win.on('close', () => {
    if (quitting) return;
    const cfg = loadCfg();
    if (!cfg.tray_hint_shown) {
      cfg.tray_hint_shown = true;
      saveCfg(cfg);
      notify('Paradox Backup ยังทำงานอยู่', 'โปรแกรมเฝ้าระวังดิสก์ต่อที่ถาดระบบ (มุมขวาล่าง) คลิกขวาที่ไอคอนเพื่อออก', 'dash');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow(page) {
  if (!win) return createWindow(page);
  if (page) win.webContents.send('goto', page);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayImage(alert) {
  return nativeImage.createFromPath(assetPath(alert ? 'tray-alert.png' : 'tray.png')).resize({ width: 16, height: 16 });
}

function updateTray(problems) {
  if (!tray) return;
  tray.setImage(trayImage(problems > 0));
  tray.setToolTip(problems > 0
    ? `Paradox Backup — ⚠ พบดิสก์มีปัญหา ${problems} แห่ง`
    : 'Paradox Backup — ดิสก์ปกติ');
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.setToolTip('Paradox Backup');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'เปิด Paradox Backup', click: () => showWindow() },
    { label: 'ดูพื้นที่ดิสก์', click: () => showWindow('disk') },
    { label: 'ตรวจดิสก์ตอนนี้', click: () => checkDisks().catch(() => {}) },
    { type: 'separator' },
    { label: 'ออกจากโปรแกรม (หยุดเฝ้าระวัง)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function applyAutostart(on) {
  if (!app.isPackaged) return;   // ไม่ลงทะเบียนตอนรันแบบ dev
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  } catch (e) { /* ignore */ }
}

// ---------------- IPC ----------------
const fail = (error) => ({ error });

ipcMain.handle('data', async (_e, day, force) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : localDateStr(new Date());
  try {
    return await collect(d, !!force);
  } catch (e) {
    return fail(String(e.message || e));
  }
});

ipcMain.handle('config', () => loadCfg());

ipcMain.handle('add-source', (_e, s) => {
  const machine = String((s && s.machine) || '').trim().slice(0, 80);
  const p = String((s && s.path) || '').trim().slice(0, 500);
  if (!machine || !p) return fail('กรอกชื่อเครื่องและ path ให้ครบ');
  const cfg = loadCfg();
  cfg.sources.push({ machine, path: p });
  saveCfg(cfg);
  let reachable = false;
  try { reachable = fs.statSync(p).isDirectory(); } catch (e) { /* ignore */ }
  checkDisks().catch(() => {});
  return { ok: true, reachable };
});

ipcMain.handle('del-source', (_e, i) => {
  const cfg = loadCfg();
  if (!Number.isInteger(i) || i < 0 || i >= cfg.sources.length) return fail('ไม่พบรายการ');
  cfg.sources.splice(i, 1);
  saveCfg(cfg);
  checkDisks().catch(() => {});
  return { ok: true };
});

ipcMain.handle('save-settings', (_e, s) => {
  try {
    const cfg = loadCfg();
    for (const k of ['noon', 'evening']) {
      hm(s[k][0]); hm(s[k][1]);
      cfg[k] = [String(s[k][0]).trim(), String(s[k][1]).trim()];
    }
    const rf = parseInt(s.refresh_min, 10);
    const wf = parseFloat(s.warn_free_gb);
    const wp = parseFloat(s.warn_used_pct);
    if (!(rf >= 1) || !(wf >= 0) || !(wp > 0 && wp <= 100)) throw new Error('bad number');
    cfg.refresh_min = rf;
    cfg.warn_free_gb = wf;
    cfg.warn_used_pct = wp;
    cfg.autostart = !!s.autostart;
    saveCfg(cfg);
    scanCache.clear();
    applyAutostart(cfg.autostart);
    scheduleChecks();
    alertState.clear();
    checkDisks().catch(() => {});
    return { ok: true };
  } catch (e) {
    return fail('เวลาต้องเป็น HH:MM, เกณฑ์ GB ≥ 0, เปอร์เซ็นต์ 1–100');
  }
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'เลือกโฟลเดอร์ backup', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('test-notify', () => {
  notify('✦ ทดสอบการแจ้งเตือน', 'ถ้าเห็นข้อความนี้ แปลว่าการแจ้งเตือนดิสก์ใกล้เต็มทำงานปกติ', 'disk');
  return { ok: true };
});

// ---------------- lifecycle ----------------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applyAutostart(loadCfg().autostart);
  createTray();
  if (!process.argv.includes('--hidden')) createWindow();
  scheduleChecks();
  setTimeout(() => checkDisks().catch(() => {}), 4000);
});

app.on('window-all-closed', () => { /* อยู่ที่ถาดระบบต่อ */ });
app.on('before-quit', () => { quitting = true; });
