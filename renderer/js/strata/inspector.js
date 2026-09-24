/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — el inspector de fila
   El panel a la derecha del grid. El grid muestra una línea por celda; acá
   va el valor completo, con su forma: JSON indentado, texto con sus saltos,
   la imagen de un blob, o su volcado hexadecimal. Todo seleccionable.

   Lo que el grid trae recortado (texto largo, blobs) se pide entero recién
   cuando hace falta, por rowid. Una vista o un resultado de consulta no
   tienen rowid: ahí el inspector muestra lo que hay y lo dice.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../icons.js';
import { esc } from '../ui.js';
import { fmtBytes, fmtInt } from '../format.js';
import { initScrollFades } from '../motion.js';
import { api, copyValue } from './state.js';
import {
  kindOf, displayText, copyText, jsonValue, asJSON, jsonHTML, hexDump,
  isImage, blobLabel, isTruncated,
} from './cells.js';

const AUTO_IMAGE = 4 * 1024 * 1024;   // imágenes hasta este tamaño se cargan solas

/**
 * @param {HTMLElement} aside   el .op-inspector
 * @param {{ table?: string, columns: {name:string,type?:string}[] }} ctx
 */
export function createInspector(aside, ctx) {
  let current = null;       // { r, c, row, rowid }
  let token = 0;
  const full = new Map();   // "rowid:col" → valor completo ya pedido

  aside.innerHTML = `
    <div class="op-inspector__head">
      <div class="op-col op-grow" style="min-width:0">
        <span class="op-eyebrow">Fila</span>
        <span class="st-insp__title op-num" data-role="title">—</span>
      </div>
      <button class="op-iconbtn op-iconbtn--sm" data-role="copy-row" data-tip="Copiar la fila como JSON"><i data-icon="json"></i></button>
    </div>
    <div class="op-inspector__body op-scroll" data-role="body"></div>`;
  Icons.mount(aside);
  const body = aside.querySelector('[data-role="body"]');
  const title = aside.querySelector('[data-role="title"]');
  initScrollFades(aside);

  function rowJSON() {
    if (!current?.row) return null;
    const out = {};
    ctx.columns.forEach((c, i) => {
      const k = `${current.rowid}:${i}`;
      out[c.name] = jsonValue(full.get(k) ?? current.row[i]);
    });
    return JSON.stringify(out, null, 2);
  }

  aside.querySelector('[data-role="copy-row"]').addEventListener('click', () => {
    const j = rowJSON();
    if (j) copyValue(j, 'Fila copiada como JSON');
  });

  function valueHTML(v, i) {
    const k = kindOf(v);
    if (k === 'null') return '<span class="st-v st-v--null">NULL</span>';
    if (k === 'int' || k === 'real') return `<span class="st-num-val op-mono">${esc(displayText(v))}</span>`;

    if (k === 'text') {
      const s = typeof v === 'string' ? v : v.t;
      const more = isTruncated(v)
        ? `<button class="op-btn op-btn--ghost op-btn--sm st-field__more" data-load="${i}" ${current.rowid ? '' : 'disabled'}>
             <i data-icon="download"></i> ${current.rowid ? `Cargar completo · ${fmtInt(v.n)} caracteres` : `Recortado: ${fmtInt(v.n)} caracteres`}
           </button>`
        : '';
      const json = !isTruncated(v) && asJSON(s);
      if (json) return `<pre class="st-code st-code--json">${jsonHTML(json)}</pre>`;
      return `<div class="st-text">${esc(s)}</div>${more}`;
    }

    // BLOB
    const label = blobLabel(v);
    const loaded = v.h.length >= v.b;
    const meta = `<div class="st-blobmeta"><span class="op-chip op-chip--mono">${esc(label)}</span><span class="op-meta op-num">${fmtBytes(v.b)}</span></div>`;
    if (isImage(v) && loaded) {
      const src = `data:${v.m};base64,${b64(v.h)}`;
      return `${meta}<div class="st-img"><img src="${src}" alt=""></div>`;
    }
    const more = !loaded && current.rowid
      ? `<button class="op-btn op-btn--ghost op-btn--sm st-field__more" data-load="${i}">
           <i data-icon="download"></i> ${isImage(v) ? 'Ver imagen' : 'Cargar completo'}</button>`
      : '';
    return `${meta}<pre class="st-hex">${hexDump(v.h)}${v.h.length > 4096 ? '\n…' : ''}</pre>${more}`;
  }

  function render() {
    if (!current?.row) {
      title.textContent = '—';
      body.innerHTML = `<div class="st-insp__empty">${Icons.svg('column')}<span>Elegí una fila para ver sus valores completos</span></div>`;
      return;
    }
    title.textContent = `${fmtInt(current.r + 1)}${current.rowid != null ? `  ·  rowid ${current.rowid}` : ''}`;
    body.innerHTML = ctx.columns.map((c, i) => {
      const v = full.get(`${current.rowid}:${i}`) ?? current.row[i];
      return `<section class="st-field${i === current.c ? ' is-focus' : ''}" data-i="${i}">
        <div class="st-field__head">
          <span class="st-field__name">${esc(c.name)}</span>
          ${c.type ? `<span class="st-field__type">${esc(c.type)}</span>` : ''}
          <button class="op-iconbtn op-iconbtn--sm st-field__copy" data-copy-field="${i}" data-tip="Copiar valor"><i data-icon="copy"></i></button>
        </div>
        <div class="st-field__val">${valueHTML(v, i)}</div>
      </section>`;
    }).join('');
    Icons.mount(body);
    autoload();
  }

  /** Imágenes chicas: se cargan solas, que para eso se abrió el inspector. */
  function autoload() {
    if (!current?.rowid || !ctx.table) return;
    ctx.columns.forEach((_c, i) => {
      const v = current.row[i];
      if (isImage(v) && v.b <= AUTO_IMAGE && v.h.length < v.b && !full.has(`${current.rowid}:${i}`)) load(i);
    });
  }

  async function load(i) {
    if (!current?.rowid || !ctx.table) return;
    const my = token;
    const key = `${current.rowid}:${i}`;
    const btn = body.querySelector(`[data-load="${i}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = `${Icons.spinner()} Cargando…`; }
    try {
      const v = await api.db.cell({ table: ctx.table, rowid: current.rowid, column: ctx.columns[i].name });
      full.set(key, v);
      if (full.size > 40) full.delete(full.keys().next().value);
      if (my === token) render();
    } catch (err) {
      if (btn && my === token) { btn.disabled = false; btn.textContent = err.message; }
    }
  }

  body.addEventListener('click', (e) => {
    const ld = e.target.closest('[data-load]');
    if (ld) return load(Number(ld.dataset.load));
    const cp = e.target.closest('[data-copy-field]');
    if (cp && current?.row) {
      const i = Number(cp.dataset.copyField);
      const v = full.get(`${current.rowid}:${i}`) ?? current.row[i];
      copyValue(copyText(v), `Copiado: ${ctx.columns[i].name}`);
    }
  });

  return {
    /** El cursor del grid se movió. */
    show(info) {
      const sameRow = current && info && current.r === info.r && current.row === info.row;
      current = info;
      token++;
      if (sameRow) {
        body.querySelectorAll('.st-field').forEach((f) => f.classList.toggle('is-focus', Number(f.dataset.i) === info.c));
      } else {
        render();
      }
      body.querySelector('.st-field.is-focus')?.scrollIntoView({ block: 'nearest' });
    },
    /** El valor completo de una celda, si ya se pidió. */
    fullValue: (rowid, i) => full.get(`${rowid}:${i}`),
    clear() { current = null; token++; render(); },
  };
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
