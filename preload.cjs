'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — preload
   La única puerta entre el renderer y el sistema. Todo lo que NO esté acá, el
   renderer no lo puede hacer: no tiene require, ni fs, ni acceso al proceso
   principal. Esa es la idea.

   Regla (de Opal): exponé funciones, nunca objetos de Electron. `ipcRenderer`
   en el window anula por completo el aislamiento de contexto.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

/** Suscripción a un evento del main; devuelve la función que la suelta. */
const on = (channel) => (cb) => {
  const handler = (_e, value) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

const win = {
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  /** El renderer le pasa a la ventana su color base ya resuelto (ver app.js). */
  setBackground: (hex) => ipcRenderer.send('win:set-bg', hex),
  onMaximized: on('win:maximized'),
};

contextBridge.exposeInMainWorld('strata', {
  info: () => call('app:info'),
  win,

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
  },

  recents: {
    list: () => call('recents:list'),
    remove: (p) => call('recents:remove', p),
    clear: () => call('recents:clear'),
  },

  /** La base abierta. Siempre de solo lectura: no hay un solo canal que escriba. */
  db: {
    pick: () => call('db:pick'),
    open: (p) => call('db:open', p),
    close: () => call('db:close'),
    cancel: () => call('db:cancel'),
    info: () => call('db:info'),
    overview: () => call('db:overview'),
    schema: () => call('db:schema'),
    counts: (names) => call('db:counts', names),
    structure: (name) => call('db:structure', name),
    meta: (name) => call('db:meta', name),
    rows: (q) => call('db:rows', q),
    count: (q) => call('db:count', q),
    cell: (q) => call('db:cell', q),
    query: (sql) => call('db:query', sql),
    queryPage: (q) => call('db:query-page', q),
    export: (opts) => call('db:export', opts),
  },

  /** Actualizaciones: el estado ('idle' | 'downloading' | 'ready') y reiniciar. */
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: on('update:state'),
  },

  /** Una base que llegó por fuera de la interfaz: argv, segunda instancia. */
  onOpenFile: on('app:open-file'),
  /** La base que vino por argv al arrancar, si hubo (se entrega una sola vez). */
  pendingFile: () => call('app:pending-file'),
  /** Carpeta del archivo en el Explorador, con el archivo seleccionado. */
  reveal: (p) => call('shell:reveal', p),
  /** Ruta real de un File soltado en drag & drop (Electron ≥ 32 no da .path). */
  pathForFile: (file) => webUtils.getPathForFile(file),
});

/* Las piezas de Opal (la vitrina de Piezas) buscan `window.opal.win`. Se les
   da solo eso, con el mismo nombre de siempre, para no editar el framework. */
contextBridge.exposeInMainWorld('opal', { win });
