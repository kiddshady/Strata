'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — bases recientes
   Las lleva el proceso principal y no el renderer: una base puede abrirse
   sin pasar por la interfaz (doble click en el Explorador, arrastrarla al
   ícono), y la lista tiene que enterarse igual.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs/promises');
const path = require('path');
const store = require('./store.cjs');

const MAX = 12;
const doc = store.doc('recent', []);

/** Normaliza lo guardado: la versión de la plantilla era un array de rutas. */
function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => (typeof r === 'string' ? { path: r } : r))
    .filter((r) => r && typeof r.path === 'string' && r.path)
    .map((r) => ({ path: r.path, name: r.name || path.basename(r.path), openedAt: Number(r.openedAt) || 0 }));
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** La lista, con el estado actual de cada archivo (tamaño, o que ya no está). */
async function list() {
  const items = normalize(await doc.read());
  return Promise.all(items.map(async (r) => {
    try {
      const st = await fs.stat(r.path);
      return { ...r, size: st.size, missing: false };
    } catch {
      return { ...r, size: null, missing: true };
    }
  }));
}

async function push(filePath) {
  const items = normalize(await doc.read()).filter((r) => !same(r.path, filePath));
  items.unshift({ path: filePath, name: path.basename(filePath), openedAt: Date.now() });
  await doc.write(items.slice(0, MAX));
}

async function remove(filePath) {
  const items = normalize(await doc.read()).filter((r) => !same(r.path, filePath));
  await doc.write(items);
}

async function clear() {
  await doc.write([]);
}

module.exports = { list, push, remove, clear };
