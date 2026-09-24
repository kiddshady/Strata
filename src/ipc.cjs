'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — puente IPC
   El renderer no tiene fs, ni require, ni red: `contextIsolation` está activo.
   Todo lo que necesite del sistema pasa por acá, y acá se decide qué se puede
   pedir. Es la superficie de ataque de la app: cada canal es una puerta más,
   así que no hay canales genéricos (nada de "leé el documento que quieras").

   Convención (de Opal): cada handler devuelve {ok:true, data} o {ok:false,
   error}. El preload la desenvuelve y convierte el error en una excepción
   real, así el renderer escribe try/catch normal en vez de chequear banderas.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const store = require('./store.cjs');
const recents = require('./recents.cjs');
const db = require('./db.cjs');

const SQLITE_EXT = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'];

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(e, ...args) };
    } catch (err) {
      // "Cancelado" es un resultado, no un error: no ensucia la consola.
      if (err?.message !== 'Cancelado') console.error(`[ipc] ${channel}:`, err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

const str = (v, what) => {
  if (typeof v !== 'string' || !v) throw new Error(`Falta ${what}`);
  return v;
};

/** Solo las claves que existen en los ajustes: el renderer no inventa claves. */
function settingsPatch(patch) {
  const out = {};
  for (const k of Object.keys(store.DEFAULT_SETTINGS)) {
    if (k !== 'schema' && patch && k in patch) out[k] = patch[k];
  }
  return out;
}

/** La base que vino por argv al arrancar: se entrega una vez y se olvida. */
let pendingFile = null;
function setPendingFile(p) { pendingFile = p || null; }

/** Abre una base y la anota en recientes y como la última abierta. */
async function openDatabase(filePath) {
  const info = await db.open(path.resolve(str(filePath, 'la ruta')));
  await recents.push(info.path).catch((err) => console.error('[recientes]', err.message));
  await store.saveSettings({ ultimaBase: info.path }).catch(() => {});
  return info;
}

function register() {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    electron: process.versions.electron,
    dev: process.argv.includes('--dev'),
  }));

  handle('app:pending-file', () => {
    const p = pendingFile;
    pendingFile = null;
    return p;
  });

  handle('settings:get', () => store.loadSettings());
  handle('settings:save', (_e, patch) => store.saveSettings(settingsPatch(patch)));

  handle('recents:list', () => recents.list());
  handle('recents:remove', (_e, p) => recents.remove(str(p, 'la ruta')).then(() => recents.list()));
  handle('recents:clear', () => recents.clear().then(() => []));

  /* ── La base ───────────────────────────────────────────────────────────── */
  handle('db:pick', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Abrir base SQLite',
      properties: ['openFile'],
      filters: [
        { name: 'Bases SQLite', extensions: SQLITE_EXT },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  handle('db:open', (_e, p) => openDatabase(p));
  handle('db:close', async () => {
    await db.close();
    await store.saveSettings({ ultimaBase: null }).catch(() => {});
    return true;
  });
  handle('db:cancel', () => db.cancel());

  // Lecturas: pasan directo al proceso de la base, que valida lo suyo.
  handle('db:info', () => db.call('info'));
  handle('db:overview', () => db.call('overview'));
  handle('db:schema', () => db.call('schema'));
  handle('db:counts', (_e, names) => db.call('counts', Array.isArray(names) ? names.map(String) : []));
  handle('db:structure', (_e, name) => db.call('structure', str(name, 'el objeto')));
  handle('db:meta', (_e, name) => db.call('meta', str(name, 'el objeto')));
  handle('db:rows', (_e, q) => db.call('rows', q));
  handle('db:count', (_e, q) => db.call('count', q));
  handle('db:cell', (_e, q) => db.call('cell', q));
  handle('db:query', (_e, sql) => db.call('query', String(sql ?? '')));
  handle('db:query-page', (_e, q) => db.call('queryPage', q));

  /* Exportar: el diálogo lo abre el main, así el renderer nunca elige una
     ruta de escritura por su cuenta. Devuelve null si se canceló. */
  handle('db:export', async (e, { source, format, name }) => {
    const fmt = format === 'json' ? 'json' : 'csv';
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: `Exportar como ${fmt.toUpperCase()}`,
      defaultPath: `${String(name || 'resultado').replace(/[\\/:*?"<>|]+/g, '_')}.${fmt}`,
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (r.canceled || !r.filePath) return null;
    return db.call('export', { source, format: fmt, target: r.filePath });
  });

  /* ── Sistema ───────────────────────────────────────────────────────────── */
  handle('shell:reveal', (_e, p) => { shell.showItemInFolder(path.resolve(str(p, 'la ruta'))); return true; });
}

module.exports = { register, openDatabase, setPendingFile };
