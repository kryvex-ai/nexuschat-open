'use strict';

const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const brand = require('../shared/brand');
const { Store } = require('./store');
const { createSecureAdapter } = require('./secure');
const { initIpc } = require('./ipc');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let store = null;
  let botStore = null;
  let quitting = false;

  function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 980,
      minHeight: 620,
      backgroundColor: '#14161F',
      title: brand.APP_NAME,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    if (process.platform !== 'darwin') {
      win.setMenuBarVisibility(false);
    }
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Open external links in the system browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) {
        e.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });

    // "Run in background" (Settings): closing the window hides the app to
    // the tray instead of quitting, so offline bots keep working 24/7.
    win.on('close', e => {
      if (!quitting && store && store.getSettings().runInBackground === true) {
        e.preventDefault();
        win.hide();
        ensureTray();
      }
    });

    // Headless smoke test hook: NEXUS_SMOKE=1 electron .  -> prints SMOKE_OK and quits.
    if (process.env.NEXUS_SMOKE === '1') {
      win.webContents.once('did-finish-load', () => {
        console.log('SMOKE_OK', brand.APP_NAME);
        setTimeout(() => app.exit(0), 400);
      });
      setTimeout(() => { console.error('SMOKE_TIMEOUT'); app.exit(1); }, 20000).unref();
    }

    win.on('closed', () => { win = null; });
  }

  function showWindow() {
    if (!win) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Tray icon + tooltip, created on demand when background mode is on. */
  function ensureTray() {
    if (tray) { updateTrayTooltip(); return; }
    try {
      let icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
      if (icon.isEmpty()) icon = undefined;
      tray = new Tray(icon || undefined);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open ' + brand.APP_NAME, click: showWindow },
        { type: 'separator' },
        {
          label: 'Quit', click: () => {
            quitting = true;
            app.quit();
          }
        }
      ]));
      tray.setToolTip(brand.APP_NAME);
      tray.on('click', showWindow);
      updateTrayTooltip();
      if (!trayTooltipTimer) {
        trayTooltipTimer = setInterval(updateTrayTooltip, 15000);
        if (trayTooltipTimer.unref) trayTooltipTimer.unref();
      }
    } catch {
      tray = null; // headless / tray unsupported — background mode simply keeps the process alive
    }
  }

  let trayTooltipTimer = null;

  function updateTrayTooltip() {
    if (!tray) return;
    let running = 0;
    try {
      running = botStore ? botStore.list().filter(b => b.status === 'running').length : 0;
    } catch { /* store unavailable — keep generic tooltip */ }
    tray.setToolTip(
      running > 0
        ? `${brand.APP_NAME} — ${running} bot${running === 1 ? '' : 's'} running in background`
        : `${brand.APP_NAME} — running in background`
    );
  }

  function destroyTray() {
    if (trayTooltipTimer) { clearInterval(trayTooltipTimer); trayTooltipTimer = null; }
    if (tray) { tray.destroy(); tray = null; }
  }

  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'), createSecureAdapter());
    const handles = initIpc(store);
    botStore = handles.botStore;
    if (store.getSettings().runInBackground === true) ensureTray();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray when background mode is on (bots keep running);
    // otherwise quit as before. macOS keeps the dock-alive convention.
    if (tray || process.platform === 'darwin') return;
    app.quit();
  });

  app.on('before-quit', () => { quitting = true; destroyTray(); });
}
