/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — celdas
   Cómo se ve, se copia y se inspecciona cada valor. Lee el formato compacto
   que arma src/sqlread.cjs (encodeValue):

     null · number entero (INTEGER) · number con decimales (REAL)
     {i}  INTEGER grande, exacto como texto     {r}  REAL de valor entero
     string TEXT                                {t,n} TEXT recortado
     {b,h,m} BLOB: tamaño, primeros bytes y tipo detectado

   Los DATOS no se localizan: un REAL se muestra con punto, como lo escribe
   SQLite, porque es lo que se copia a una consulta. Lo que se localiza es la
   interfaz alrededor (conteos, tamaños): eso pasa por format.js.
   ═══════════════════════════════════════════════════════════════════════════ */

import { esc } from '../ui.js';
import { fmtBytes } from '../format.js';

export function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  if (typeof v === 'string') return 'text';
  if ('i' in v) return 'int';
  if ('r' in v) return 'real';
  if ('t' in v) return 'text';
  if ('b' in v) return 'blob';
  return 'text';
}

/** Un REAL como lo imprime SQLite (%.15g): 27.88 y no 27.879999999999995. */
export function fmtReal(n) {
  if (n === Infinity) return 'Inf';
  if (n === -Infinity) return '-Inf';
  let s = String(Number(n.toPrecision(15)));
  if (/e/.test(s)) s = s.replace(/e\+?/, 'e+').replace('e+-', 'e-');
  else if (!s.includes('.')) s += '.0';
  return s;
}

const MIME_LABEL = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WEBP', 'image/bmp': 'BMP',
  'application/pdf': 'PDF', 'application/zip': 'ZIP', 'application/gzip': 'GZIP',
  'application/x-sqlite3': 'SQLite',
};

export const isImage = (v) => kindOf(v) === 'blob' && /^image\//.test(v.m || '');
export const blobLabel = (v) => MIME_LABEL[v.m] || 'BLOB';
export const isTruncated = (v) => v && typeof v === 'object' && 't' in v;

/** El texto de la celda en una línea (el grid no tiene saltos de línea). */
export function displayText(v) {
  switch (kindOf(v)) {
    case 'null': return 'NULL';
    case 'int': return typeof v === 'number' ? String(v) : v.i;
    case 'real': return fmtReal(typeof v === 'number' ? v : v.r);
    case 'blob': return `${blobLabel(v)} · ${fmtBytes(v.b)}`;
    default: {
      const s = typeof v === 'string' ? v : v.t;
      return (s.length > 400 ? s.slice(0, 400) : s).replace(/\s*[\r\n]+\s*/g, ' ');
    }
  }
}

/** El HTML de una celda del grid: el tipo decide la clase, no el contenido. */
export function cellHTML(v) {
  const k = kindOf(v);
  const text = esc(displayText(v));
  if (k === 'text') return text;
  return `<span class="st-v st-v--${k}">${text}</span>`;
}

/** Lo que va al portapapeles: el valor, no su etiqueta. NULL copia vacío. */
export function copyText(v) {
  switch (kindOf(v)) {
    case 'null': return '';
    case 'int': case 'real': return displayText(v);
    case 'blob': return `x'${hex(v.h, '')}'${v.b > v.h.length ? ' (recortado)' : ''}`;
    default: return typeof v === 'string' ? v : v.t;
  }
}

/** El valor en JS, para armar el JSON de una fila. */
export function jsonValue(v) {
  switch (kindOf(v)) {
    case 'null': return null;
    case 'int': return typeof v === 'number' ? v : v.i;
    case 'real': return typeof v === 'number' ? v : v.r;
    case 'blob': return { blob: blobLabel(v), bytes: v.b };
    default: return typeof v === 'string' ? v : v.t;
  }
}

export function hex(bytes, sep = ' ') {
  return Array.from(bytes || [], (b) => b.toString(16).padStart(2, '0')).join(sep);
}

/** Volcado clásico: offset · bytes en hex · ASCII imprimible. De a 8 por
    línea: son los que entran en el ancho del inspector sin scroll lateral. */
export function hexDump(bytes, max = 4096, per = 8) {
  const u8 = bytes.subarray(0, max);
  const lines = [];
  for (let off = 0; off < u8.length; off += per) {
    const row = u8.subarray(off, off + per);
    const hx = hex(row).padEnd(per * 3 - 1, ' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`<span class="st-hex__off">${off.toString(16).padStart(6, '0')}</span>  ${esc(hx)}  <span class="st-hex__asc">${esc(ascii)}</span>`);
  }
  return lines.join('\n');
}

/** Si el texto es JSON (objeto o array), su versión indentada; si no, null. */
export function asJSON(s) {
  const t = String(s).trim();
  if (!/^[[{]/.test(t)) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** JSON indentado y con las claves teñidas: el acento talla, no rellena. */
export function jsonHTML(value) {
  const src = JSON.stringify(value, null, 2);
  return esc(src).replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, lit) => {
      if (str) return colon ? `<span class="st-tk-key">${str}</span>${colon}` : `<span class="st-tk-str">${str}</span>`;
      if (lit) return `<span class="st-tk-lit">${m}</span>`;
      return `<span class="st-tk-num">${m}</span>`;
    });
}
