// PrintSaaS Agent: tray app. Sits in the taskbar notification area (Windows) / menu bar (macOS),
// shows whether this computer is connected, starts with the computer, and prints paid orders.
import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentClient } from '../src/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const DEFAULT_SERVER = process.env.PRINTSAAS_SERVER || pkg.printsaas?.defaultServer || '';

if (!app.requestSingleInstanceLock()) app.quit(); // already running: the first copy shows its window instead

app.setAppUserModelId('com.printsaas.agent');
app.on('window-all-closed', () => { /* keep running in the tray */ });

let tray = null;
let win = null;
let quitting = false;
let client = null;

const ICON = { connected: 'green', connecting: 'amber', disconnected: 'red', unpaired: 'grey' };
const trayImage = (status) => nativeImage.createFromPath(path.join(here, 'assets', `tray-${ICON[status] ?? 'grey'}.png`));

function describe(s) {
  if (s.status === 'connected') return `Connected to ${s.shopName ?? 'your shop'}`;
  if (s.status === 'connecting') return 'Connecting…';
  if (s.status === 'disconnected') return 'Not connected (retrying)';
  return 'Not set up';
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // in development this would register the bare Electron binary
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'], openAsHidden: true });
}

function fullState() {
  return { ...client.state(), defaultServer: DEFAULT_SERVER, version: app.getVersion(), platform: process.platform };
}

function showWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 460, height: 700, minWidth: 400, minHeight: 520, show: false, autoHideMenuBar: true, title: 'PrintSaaS Agent',
      icon: path.join(here, 'assets', 'icon.png'),
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.loadFile(path.join(here, 'ui', 'index.html'));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); app.dock?.hide(); } });
    win.once('ready-to-show', () => win.show());
  } else {
    win.show();
  }
  app.dock?.show();
  win.focus();
}

function refreshTray() {
  if (!tray) return;
  const s = client.state();
  tray.setImage(trayImage(s.status));
  tray.setToolTip(`PrintSaaS Agent: ${describe(s)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `PrintSaaS: ${describe(s)}`, enabled: false },
    { type: 'separator' },
    { label: 'Open PrintSaaS Agent', click: showWindow },
    { label: 'Fetch my printers', enabled: s.status === 'connected', click: () => client.syncPrinters({ includeVirtual: client.dryRun }).catch(() => {}) },
    { label: 'Open dashboard', enabled: !!s.server, click: () => s.server && shell.openExternal(`${s.server}/dashboard`) },
    { type: 'separator' },
    { label: 'Start with this computer', type: 'checkbox', checked: s.autoStart, enabled: app.isPackaged, click: (item) => client.setOption('autoStart', item.checked) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function pushState() {
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send('state', fullState());
}

const fail = (e) => ({ ok: false, error: e?.message || 'Something went wrong' });

function registerIpc() {
  ipcMain.handle('agent:state', () => fullState());

  ipcMain.handle('agent:pair', async (_e, server, code) => {
    if (typeof server !== 'string' || typeof code !== 'string') return fail(new Error('Invalid input'));
    try {
      await client.pair(server, code);
    } catch (e) { return fail(e); }
    let sync = null;
    try { sync = await client.syncPrinters({ includeVirtual: client.dryRun }); } catch { /* can be done later with "Fetch my printers" */ }
    return { ok: true, sync };
  });

  ipcMain.handle('agent:fetch', async (_e, opts) => {
    try { return { ok: true, result: await client.syncPrinters({ includeVirtual: opts?.includeVirtual === true }) }; } catch (e) { return fail(e); }
  });

  ipcMain.handle('agent:option', async (_e, name, value) => {
    try { await client.setOption(name, value); return { ok: true }; } catch (e) { return fail(e); }
  });

  ipcMain.handle('agent:unpair', async () => { await client.unpair(); return { ok: true }; });

  ipcMain.handle('agent:openDashboard', async () => {
    const s = client.state().server;
    if (s && /^https?:\/\//.test(s)) await shell.openExternal(`${s}/dashboard`);
    return { ok: true };
  });
}

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; client?.stop(); });
app.on('activate', () => showWindow()); // macOS: dock icon clicked

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  client = new AgentClient({ configPath: path.join(app.getPath('userData'), 'agent.json'), dryRun: process.env.PRINT_DRY_RUN === '1' });
  client.on('status', pushState);
  client.on('option', (name, value) => { if (name === 'autoStart') applyAutoStart(value); pushState(); });
  client.on('log', (m) => console.log(new Date().toISOString().slice(11, 19), m));
  client.on('job', (ev) => {
    if (ev.status === 'failed' && Notification.isSupported()) new Notification({ title: `Order #${ev.orderCode} did not print`, body: ev.error ?? 'Open PrintSaaS Agent for details' }).show();
  });

  registerIpc();
  tray = new Tray(trayImage('unpaired'));
  tray.on('click', showWindow);
  refreshTray();
  applyAutoStart(client.state().autoStart);

  const startedHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  await client.start();
  if (!client.state().paired || !startedHidden) showWindow();
  if (process.platform === 'darwin' && startedHidden && client.state().paired) app.dock?.hide();
});
