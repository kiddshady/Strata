/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — estado
   El espejo en memoria de lo que hay abierto. Las vistas leen de acá y se
   enteran de los cambios por eventos ('db', 'counts', 'recents', 'settings');
   solo se vuelve a pedir por IPC lo que cambió.
   ═══════════════════════════════════════════════════════════════════════════ */

import Router from '../router.js';
import { Toast } from '../overlays.js';
import { ellipsize, fmtInt } from '../format.js';

export const api = window.strata;

export const S = {
  info: null,
  settings: {},
  /** { path, name, size, wal, mtime } de la base abierta, o null. */
  db: null,
  overview: null,
  /** Objetos del esquema, como los devuelve el worker (schema()). */
  objects: [],
  /** nombre → filas. Llega después del esquema: en bases grandes tarda. */
  counts: {},
  countsReady: false,
  recents: [],
  /** Pestaña por la que se entró a la última tabla: se respeta al cambiar. */
  tab: 'datos',
};

/* ── Eventos ─────────────────────────────────────────────────────────────── */
const bus = new EventTarget();

export function on(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/* ── Consultas sobre el esquema ──────────────────────────────────────────── */
export const obj = (name) => S.objects.find((o) => o.name === name) || null;
export const ofKind = (kind) => S.objects.filter((o) => o.kind === kind);

/** Lo que se abre como grid: todo lo que tiene filas. */
export const hasRows = (o) => !!o && (o.type === 'table' || o.type === 'view');

export const KIND = {
  table: { one: 'Tabla', many: 'Tablas' },
  view: { one: 'Vista', many: 'Vistas' },
  virtual: { one: 'Tabla virtual', many: 'Virtuales' },
  internal: { one: 'Tabla interna', many: 'Internas' },
  index: { one: 'Índice', many: 'Índices' },
  trigger: { one: 'Trigger', many: 'Triggers' },
};

/** A dónde lleva un objeto del esquema: grid si tiene filas, ficha si no. */
export function routeOf(o) {
  return hasRows(o) ? ['tabla', o.name] : ['objeto', o.name];
}

/** Router.go, pero si ya estás ahí vuelve a montar (p. ej. otra base abierta). */
export function show(name, param = null) {
  if (!Router.go(name, param)) Router.refresh();
}

/* ── Vida de una vista asincrónica ───────────────────────────────────────────
   Una vista que espera al worker puede volver cuando ya se navegó a otra. Esto
   le da una pregunta barata para hacerse después de cada await: ¿sigo viva? */
let mountSeq = 0;
export function alive() {
  const mine = ++mountSeq;
  Router.onLeave(() => { if (mountSeq === mine) mountSeq++; });
  return () => mountSeq === mine;
}

/* ── Ajustes ─────────────────────────────────────────────────────────────── */
let saveTimer = null;
let pendingPatch = {};
/** Guarda con debounce: tipear en la consola no escribe el disco por tecla. */
export function saveSettings(patch, { now = false } = {}) {
  Object.assign(S.settings, patch);
  Object.assign(pendingPatch, patch);
  clearTimeout(saveTimer);
  const flush = () => {
    const p = pendingPatch;
    pendingPatch = {};
    return api.settings.save(p).catch((err) => console.error('[ajustes]', err));
  };
  if (now) return flush();
  saveTimer = setTimeout(flush, 500);
  return null;
}

/* ── Portapapeles ────────────────────────────────────────────────────────────
   El copy() de ui.js pone el texto entero en el toast; una celda puede traer
   un documento de 2 MB. Acá el toast lleva una muestra de una línea. */
export async function copyValue(text, label = 'Copiado') {
  try {
    await navigator.clipboard.writeText(String(text));
    const sample = String(text).replace(/\s+/g, ' ').trim();
    Toast.show({ title: label, text: sample ? ellipsize(sample, 72) : '(vacío)', icon: 'copy', duration: 2400 });
    return true;
  } catch (err) {
    Toast.error('No se pudo copiar', err.message);
    return false;
  }
}

/** "1.234 filas" / "1 fila": el conteo exacto, con su palabra. */
export function countLabel(n, one, many = `${one}s`) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
