'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — la base, vista desde el proceso principal
   No toca SQLite: le habla al proceso de la base (db-worker.cjs) y le pone
   una interfaz de promesas encima. Lo único que sabe hacer que ese proceso no
   puede es MORIR Y VOLVER: cancelar una consulta es matarlo, levantar otro y
   reabrir la misma base, como si nada.
   ═══════════════════════════════════════════════════════════════════════════ */

const { utilityProcess } = require('electron');
const path = require('path');

const WORKER = path.join(__dirname, 'db-worker.cjs');

/** @type {{ proc: Electron.UtilityProcess, ready: Promise<void> } | null} */
let child = null;
let seq = 0;
/** id → { resolve, reject } de los pedidos que todavía no volvieron. */
const pending = new Map();
/** La ruta abierta: es lo que se reabre después de cancelar. */
let currentPath = null;

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function spawn() {
  const proc = utilityProcess.fork(WORKER, [], { serviceName: 'Strata · base', stdio: 'inherit' });
  const me = {
    proc,
    ready: new Promise((resolve) => proc.once('spawn', resolve)),
  };
  proc.on('message', ({ id, ok, data, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(data) : p.reject(new Error(error));
  });
  proc.on('exit', (code) => {
    if (child !== me) return;           // lo matamos nosotros: ya se limpió
    child = null;
    console.error(`[db] el proceso de la base terminó solo (código ${code})`);
    failAll('El lector de la base se cerró');
  });
  return me;
}

async function call(op, ...args) {
  if (!child) child = spawn();
  const me = child;
  await me.ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    me.proc.postMessage({ id, op, args });
  });
}

async function open(filePath) {
  const info = await call('open', filePath);
  currentPath = info.path;
  return info;
}

async function close() {
  currentPath = null;
  if (child) await call('close').catch(() => {});
  return true;
}

function kill() {
  const me = child;
  child = null;
  failAll('Cancelado');
  if (me) me.proc.kill();
}

/**
 * Corta lo que esté corriendo. Todo lo que estaba en vuelo se rechaza con
 * "Cancelado", el proceso muere y el siguiente pedido encuentra la base
 * abierta otra vez. Devuelve la info de la base reabierta (o null si no había).
 */
async function cancel() {
  kill();
  return currentPath ? open(currentPath) : null;
}

function shutdown() {
  currentPath = null;
  kill();
}

module.exports = {
  call, open, close, cancel, shutdown,
  get currentPath() { return currentPath; },
};
