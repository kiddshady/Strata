'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — auto-update
   Las versiones salen como releases públicos de GitHub (kiddshady/Strata),
   con el latest.yml que genera electron-builder. Al arrancar, y después cada
   pocas horas, Strata se fija si hay una más nueva; si la hay, la baja sola en
   segundo plano y avisa en la statusbar. Se instala al cerrar la app, o al
   toque si el usuario hace click en el aviso.

   Solo corre empaquetada: en `npm run dev` no hay instalador que reemplazar,
   y electron-updater se negaría igual (no encuentra app-update.yml).
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, ipcMain } = require('electron');

const EVERY = 4 * 60 * 60 * 1000;   // cada 4 horas, para la app que queda abierta días

let send = () => {};
let state = { state: 'idle' };

function publish(next) {
  state = next;
  send(state);
}

function init(getWindow) {
  send = (s) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:state', s);
  };
  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:install', () => {
    if (state.state !== 'ready') return false;
    // isSilent: sin el asistente del NSIS; isForceRunAfter: vuelve a abrir Strata.
    setImmediate(() => autoUpdater().quitAndInstall(true, true));
    return true;
  });

  if (!app.isPackaged) return;

  const u = autoUpdater();
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.on('update-available', (i) => publish({ state: 'downloading', version: i.version, percent: 0 }));
  u.on('download-progress', (p) => publish({ ...state, state: 'downloading', percent: Math.round(p.percent) }));
  u.on('update-downloaded', (i) => publish({ state: 'ready', version: i.version }));
  u.on('update-not-available', () => publish({ state: 'idle' }));
  // Sin red, GitHub caído, rate limit: no es asunto del usuario. Se reintenta
  // en el próximo ciclo y la app sigue como estaba.
  u.on('error', (err) => { console.error('[update]', err?.message || err); publish({ state: 'idle' }); });

  const check = () => u.checkForUpdates().catch((err) => console.error('[update]', err?.message || err));
  setTimeout(check, 8000);   // que no compita con el arranque
  setInterval(check, EVERY).unref();
}

/* Se carga recién cuando hace falta: en dev (y en los tests) ni se toca. */
let cached = null;
function autoUpdater() {
  if (!cached) cached = require('electron-updater').autoUpdater;
  return cached;
}

module.exports = { init };
