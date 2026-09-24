/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — el grid
   Una tabla virtual: solo existen en el DOM las filas que se ven (y un margen),
   y los datos llegan por bloques a medida que el scroll los pide. Así da lo
   mismo que la tabla tenga 40 filas o 40 millones.

   ── Cómo está armado ───────────────────────────────────────────────────────
     .st-grid            el scroller (los dos ejes)
       __head            encabezado, sticky arriba
       __layer           la ventana de filas: sticky debajo del head, del alto
                         visible, recorta con overflow:clip (NO hidden: hidden
                         la vuelve contenedor de scroll y la columna # dejaría
                         de pegarse a la izquierda)
       __spacer          el alto que falta para que el scroll tenga recorrido

   Las filas no se posicionan en coordenadas del contenido sino de la VENTANA:
   del scrollTop sale qué fila va primera y cuánto de ella asoma. Eso permite
   la escala: un navegador no dibuja un elemento de 40 millones × 28 px, así
   que pasado MAX_H el recorrido del scroll se comprime y cada píxel pasa a
   valer más de una fila. Por debajo de MAX_H la cuenta da exactamente
   scrollTop / alto de fila, que es lo que uno espera.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../icons.js';
import { esc } from '../ui.js';
import { cellHTML, kindOf, displayText } from './cells.js';

const CHUNK = 100;
const OVERSCAN = 6;
const MAX_H = 6_000_000;
const MAX_CHUNKS = 80;          // ~8000 filas en memoria; el resto se vuelve a pedir
const INFLIGHT = 2;
const GUTTER_MIN = 44;
const COL_MIN = 56;
const COL_MAX = 420;

/* Medición de texto con canvas: lo que ocupa de verdad con la fuente real,
   sin tocar el layout. Las fuentes se leen del CSS para no repetirlas acá. */
let measureCtx = null;
function measurer() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}
function textWidth(text, font) {
  const ctx = measurer();
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * @param {HTMLElement} host   dónde se monta (se vacía)
 * @param {object} o
 * @param {{name:string,type?:string,pk?:number}[]} o.columns
 * @param {number|null} o.total           null = todavía no se sabe
 * @param {(offset:number, limit:number) => Promise<{rows:any[][], rowids?:string[]}>} o.fetch
 * @param {{column:string,dir:'asc'|'desc'}|null} [o.sort]
 * @param {(column:string|null, dir:string|null) => void} [o.onSort]
 * @param {(info:{r:number,c:number,row:any[]|null,rowid:string|null}) => void} [o.onCursor]
 * @param {(info) => void} [o.onActivate]     Enter o doble click
 * @param {(e:MouseEvent, info) => void} [o.onContext]
 * @param {(info) => void} [o.onCopy]         Ctrl+C sobre una celda
 * @param {number} [o.rowHeight]
 * @param {string} [o.emptyText]
 */
export function createGrid(host, o) {
  const opts = { rowHeight: 28, emptyText: 'Sin filas', ...o };
  const RH = opts.rowHeight;
  const cols = opts.columns;
  let total = opts.total;

  host.innerHTML = `
    <div class="st-grid" tabindex="0" role="grid" aria-rowcount="${total ?? -1}" aria-colcount="${cols.length}">
      <div class="st-grid__head" role="row"></div>
      <div class="st-grid__layer"><div class="st-grid__rows"></div></div>
      <div class="st-grid__spacer"></div>
      <div class="st-grid__empty"></div>
    </div>`;
  const el = host.firstElementChild;
  const headEl = el.querySelector('.st-grid__head');
  const layerEl = el.querySelector('.st-grid__layer');
  const rowsEl = el.querySelector('.st-grid__rows');
  const spacerEl = el.querySelector('.st-grid__spacer');
  const emptyEl = el.querySelector('.st-grid__empty');
  el.style.setProperty('--st-rh', `${RH}px`);

  /* ── Estado ─────────────────────────────────────────────────────────────── */
  const chunks = new Map();        // índice de bloque → { rows, rowids }
  const loading = new Set();
  let generation = 0;              // sube con cada reset: descarta respuestas viejas
  let widths = cols.map(() => 120);
  let userSized = new Set();       // columnas que el usuario ya ajustó a mano
  let measured = false;
  let gutterW = GUTTER_MIN;
  let cur = { r: 0, c: 0 };
  let hasCursor = false;
  let first = 0;                   // primera fila visible (float)
  let layerH = 0;
  let headH = 34;
  let lastRender = '';
  let destroyed = false;
  let sort = opts.sort || null;

  /* ── Columnas ───────────────────────────────────────────────────────────── */
  const style = getComputedStyle(el);
  const monoFont = `12px ${style.getPropertyValue('--op-mono').trim() || 'monospace'}`;
  const sansFont = `500 12px ${style.getPropertyValue('--op-font').trim() || 'sans-serif'}`;
  const typeFont = `10px ${style.getPropertyValue('--op-mono').trim() || 'monospace'}`;

  function headerWidth(c) {
    const name = textWidth(c.name, sansFont);
    const type = c.type ? textWidth(c.type.toUpperCase(), typeFont) + 6 : 0;
    // ícono de PK y de orden (12 + 6 de gap cada uno) + padding de la celda.
    return name + type + (c.pk ? 18 : 0) + 18 + 34;
  }

  function autoWidths() {
    const sample = [];
    for (const ch of chunks.values()) { sample.push(...ch.rows.slice(0, 60)); if (sample.length >= 120) break; }
    widths = cols.map((c, i) => {
      if (userSized.has(i)) return widths[i];
      let w = headerWidth(c);
      for (const r of sample) {
        const v = r[i];
        const k = kindOf(v);
        const t = displayText(v).slice(0, 80);
        w = Math.max(w, textWidth(t, k === 'text' ? sansFont : monoFont) + 26);
      }
      return Math.round(Math.min(COL_MAX, Math.max(COL_MIN, w)));
    });
    if (sample.length) measured = true;
  }

  function applyColumns() {
    const t = total ?? 0;
    gutterW = Math.max(GUTTER_MIN, Math.ceil(textWidth(String(Math.max(t, 1)), monoFont)) + 24);
    const tpl = [`${gutterW}px`, ...widths.map((w) => `${w}px`), 'minmax(0, 1fr)'].join(' ');
    el.style.setProperty('--st-cols', tpl);
    el.style.setProperty('--st-w', `${gutterW + widths.reduce((a, b) => a + b, 0)}px`);
  }

  function renderHead() {
    headEl.innerHTML = `<div class="st-gc st-gc--gutter" role="columnheader"><i data-icon="hash"></i></div>`
      + cols.map((c, i) => {
        const s = sort?.column === c.name ? sort.dir : null;
        return `<div class="st-gc st-th${s ? ' is-sorted' : ''}" role="columnheader" data-c="${i}"
            aria-sort="${s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : 'none'}">
          ${c.pk ? '<i data-icon="key" class="st-th__pk"></i>' : ''}
          <span class="st-th__name">${esc(c.name)}</span>
          ${c.type ? `<span class="st-th__type">${esc(c.type)}</span>` : ''}
          ${opts.onSort ? `<span class="st-th__sort"><i data-icon="${s === 'desc' ? 'sortDesc' : 'sortAsc'}"></i></span>` : ''}
          <span class="st-th__grip" data-grip="${i}"></span>
        </div>`;
      }).join('') + '<div class="st-gc st-gc--fill"></div>';
    Icons.mount(headEl);
  }

  /* ── Geometría ──────────────────────────────────────────────────────────── */
  function geometry() {
    const n = total ?? 0;
    const contentH = n * RH;
    const virtualH = Math.min(contentH, MAX_H);
    const spacer = Math.max(0, virtualH - layerH);
    const maxFirst = Math.max(0, n - layerH / RH);
    return { n, spacer, maxFirst };
  }

  function layout() {
    headH = headEl.offsetHeight || headH;
    layerH = Math.max(0, el.clientHeight - headH);
    layerEl.style.height = `${layerH}px`;
    const g = geometry();
    spacerEl.style.height = `${g.spacer}px`;
  }

  function firstFromScroll() {
    const g = geometry();
    return g.spacer > 0 ? Math.min(g.maxFirst, (el.scrollTop / g.spacer) * g.maxFirst) : 0;
  }

  function scrollToFirst(f) {
    const g = geometry();
    el.scrollTop = g.maxFirst > 0 ? (f / g.maxFirst) * g.spacer : 0;
  }

  /* ── Datos ──────────────────────────────────────────────────────────────── */
  function rowAt(i) {
    const ch = chunks.get(Math.floor(i / CHUNK));
    if (!ch) return null;
    const k = i % CHUNK;
    return k < ch.rows.length ? { row: ch.rows[k], rowid: ch.rowids?.[k] ?? null } : null;
  }

  function visibleChunks() {
    const n = total ?? 0;
    const a = Math.max(0, Math.floor(first) - OVERSCAN);
    const b = Math.min(n - 1, Math.ceil(first + layerH / RH) + OVERSCAN);
    const out = [];
    for (let c = Math.floor(a / CHUNK); c <= Math.floor(b / CHUNK); c++) out.push(c);
    return out;
  }

  function evict() {
    if (chunks.size <= MAX_CHUNKS) return;
    const center = Math.floor(first / CHUNK);
    const far = [...chunks.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const k of far.slice(0, chunks.size - MAX_CHUNKS)) chunks.delete(k);
  }

  function pump() {
    if (destroyed || total === null) return;
    for (const c of visibleChunks()) {
      if (loading.size >= INFLIGHT) return;
      if (chunks.has(c) || loading.has(c)) continue;
      const gen = generation;
      loading.add(c);
      opts.fetch(c * CHUNK, CHUNK).then((res) => {
        if (gen !== generation || destroyed) return;
        chunks.set(c, res);
        evict();
        if (!measured) { autoWidths(); applyColumns(); }
        schedule(true);
      }).catch((err) => {
        if (gen !== generation || destroyed) return;
        if (err?.message !== 'Cancelado') console.error('[grid] no se pudo leer un bloque:', err);
        chunks.set(c, { rows: [], failed: true });
        schedule(true);
      }).finally(() => {
        if (gen !== generation) return;
        loading.delete(c);
        pump();
      });
    }
  }

  /* ── Pintado ────────────────────────────────────────────────────────────── */
  let rafId = 0;
  let force = false;
  function schedule(f = false) {
    force = force || f;
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  function render() {
    if (destroyed) return;
    first = firstFromScroll();
    const n = total ?? 0;
    const f0 = Math.floor(first);
    const frac = (first - f0) * RH;
    rowsEl.style.transform = `translateY(${-frac}px)`;

    const a = Math.max(0, f0 - OVERSCAN);
    const b = Math.min(n - 1, f0 + Math.ceil(layerH / RH) + OVERSCAN);
    const key = `${a}:${b}:${hasCursor ? `${cur.r},${cur.c}` : '-'}:${chunks.size}:${loading.size}`;
    if (!force && key === lastRender) return;
    lastRender = key;
    force = false;

    let html = '';
    for (let i = a; i <= b; i++) {
      const y = (i - f0) * RH;
      const got = rowAt(i);
      const sel = hasCursor && cur.r === i;
      html += `<div class="st-row${sel ? ' is-sel' : ''}${i % 2 ? ' is-odd' : ''}" role="row" data-i="${i}" style="transform:translateY(${y}px)">`
        + `<div class="st-gc st-gc--gutter">${i + 1}</div>`;
      if (got) {
        for (let c = 0; c < cols.length; c++) {
          const v = got.row[c];
          const cursor = sel && cur.c === c;
          html += `<div class="st-gc st-td st-td--${kindOf(v)}${cursor ? ' is-cursor' : ''}" role="gridcell" data-c="${c}">${cellHTML(v)}</div>`;
        }
      } else {
        for (let c = 0; c < cols.length; c++) {
          html += `<div class="st-gc st-td" data-c="${c}"><span class="st-skel" style="--w:${30 + ((i * 7 + c * 13) % 50)}%"></span></div>`;
        }
      }
      html += '<div class="st-gc st-gc--fill"></div></div>';
    }
    rowsEl.innerHTML = html;
    pump();
  }

  function renderEmpty() {
    const isEmpty = total === 0;
    el.classList.toggle('is-empty', isEmpty);
    emptyEl.innerHTML = isEmpty ? `${Icons.svg('inbox')}<span>${esc(opts.emptyText)}</span>` : '';
  }

  /* ── Cursor ─────────────────────────────────────────────────────────────── */
  function info(r = cur.r, c = cur.c) {
    const got = rowAt(r);
    return { r, c, row: got?.row ?? null, rowid: got?.rowid ?? null, column: cols[c] };
  }

  function colLeft(c) {
    let x = gutterW;
    for (let i = 0; i < c; i++) x += widths[i];
    return x;
  }

  function reveal() {
    const visible = layerH / RH;
    if (cur.r < first) scrollToFirst(cur.r);
    else if (cur.r + 1 > first + visible) scrollToFirst(cur.r + 1 - visible);
    const left = colLeft(cur.c);
    const right = left + widths[cur.c];
    if (left - gutterW < el.scrollLeft) el.scrollLeft = left - gutterW;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }

  function setCursor(r, c, { scroll = true } = {}) {
    const n = total ?? 0;
    if (!n || !cols.length) return;
    cur = { r: Math.max(0, Math.min(n - 1, r)), c: Math.max(0, Math.min(cols.length - 1, c)) };
    hasCursor = true;
    if (scroll) reveal();
    schedule(true);
    // Si la fila todavía no llegó, se avisa cuando llegue (ver waitRow).
    const i = info();
    opts.onCursor?.(i);
    if (!i.row) waitRow(cur.r);
  }

  let waitingFor = null;
  function waitRow(r) {
    waitingFor = r;
    const check = () => {
      if (destroyed || waitingFor !== r) return;
      if (rowAt(r)) { waitingFor = null; if (cur.r === r) opts.onCursor?.(info()); return; }
      setTimeout(check, 60);
    };
    setTimeout(check, 60);
  }

  function cellFromEvent(e) {
    const td = e.target.closest('.st-td');
    const tr = e.target.closest('.st-row');
    if (!tr) return null;
    return { r: Number(tr.dataset.i), c: td ? Number(td.dataset.c) : cur.c };
  }

  /* ── Eventos ────────────────────────────────────────────────────────────── */
  el.addEventListener('scroll', () => schedule(), { passive: true });

  const ro = new ResizeObserver(() => { layout(); schedule(true); });
  ro.observe(el);

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.st-grid__head')) return;
    const p = cellFromEvent(e);
    if (p) setCursor(p.r, p.c, { scroll: false });
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.st-grid__head')) return;
    const p = cellFromEvent(e);
    if (p) opts.onActivate?.(info(p.r, p.c));
  });

  el.addEventListener('contextmenu', (e) => {
    const p = cellFromEvent(e);
    if (!p) return;
    e.preventDefault();
    setCursor(p.r, p.c, { scroll: false });
    el.focus({ preventScroll: true });
    opts.onContext?.(e, info(p.r, p.c));
  });

  el.addEventListener('keydown', (e) => {
    if (!total) return;
    const page = Math.max(1, Math.floor(layerH / RH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    const moves = {
      ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1],
      PageDown: [page, 0], PageUp: [-page, 0],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      if (!hasCursor) return setCursor(0, 0);
      return setCursor(cur.r + dr, ctrl && dc ? (dc > 0 ? cols.length - 1 : 0) : cur.c + dc);
    }
    if (e.key === 'Home') { e.preventDefault(); return setCursor(ctrl ? 0 : cur.r, 0); }
    if (e.key === 'End') { e.preventDefault(); return setCursor(ctrl ? total - 1 : cur.r, cols.length - 1); }
    if (e.key === 'Enter' && hasCursor) { e.preventDefault(); return opts.onActivate?.(info()); }
    if (ctrl && e.key.toLowerCase() === 'c' && hasCursor) {
      // Si hay texto seleccionado a mano en otro lado, Ctrl+C es de él.
      if (String(window.getSelection() || '').length) return;
      e.preventDefault();
      opts.onCopy?.(info());
    }
  });

  /* Encabezado: click ordena (asc → desc → sin orden), el borde redimensiona. */
  headEl.addEventListener('click', (e) => {
    if (!opts.onSort || e.target.closest('[data-grip]')) return;
    const th = e.target.closest('.st-th');
    if (!th) return;
    const name = cols[Number(th.dataset.c)].name;
    const next = sort?.column !== name ? 'asc' : sort.dir === 'asc' ? 'desc' : null;
    opts.onSort(next ? name : null, next);
  });

  headEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    e.preventDefault();
    const i = Number(grip.dataset.grip);
    const x0 = e.clientX;
    const w0 = widths[i];
    grip.setPointerCapture(e.pointerId);
    el.classList.add('is-resizing');
    const move = (ev) => {
      widths[i] = Math.max(COL_MIN, Math.round(w0 + ev.clientX - x0));
      userSized.add(i);
      applyColumns();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      el.classList.remove('is-resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('lostpointercapture', up, { once: true });
  });

  headEl.addEventListener('dblclick', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    const i = Number(grip.dataset.grip);
    userSized.delete(i);
    autoWidths();
    applyColumns();
  });

  /* ── Arranque ───────────────────────────────────────────────────────────── */
  renderHead();
  applyColumns();
  renderEmpty();
  layout();
  schedule(true);

  return {
    el,
    get total() { return total; },
    get cursor() { return hasCursor ? { ...cur } : null; },
    info,
    rowAt,
    setCursor,
    /** El total llegó (o cambió): rehace la geometría sin perder los datos. */
    setTotal(n) {
      total = n;
      el.setAttribute('aria-rowcount', String(n ?? -1));
      if (hasCursor && n && cur.r >= n) cur.r = n - 1;
      applyColumns();
      renderEmpty();
      layout();
      schedule(true);
    },
    /** Otro orden o filtro: los datos viejos no sirven, la geometría sí. */
    reset({ total: n = null, sort: s = sort } = {}) {
      generation++;
      chunks.clear();
      loading.clear();
      sort = s;
      hasCursor = false;
      renderHead();
      el.scrollTop = 0;
      this.setTotal(n);
    },
    focus() { el.focus({ preventScroll: true }); },
    destroy() {
      destroyed = true;
      generation++;
      cancelAnimationFrame(rafId);
      ro.disconnect();
    },
  };
}
