'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — lectura de SQLite, la parte pura
   Todo lo que no necesita una base abierta: citar identificadores, armar el
   SELECT de una tabla con orden y filtro, y codificar cada celda para que
   viaje barata por IPC sin perder lo que SQLite sabe de ella.

   Vive separado del worker para poder probarlo con node pelado: el
   better-sqlite3 instalado está compilado contra el ABI de Electron y en node
   no carga (ver test/sqlread.test.cjs).
   ═══════════════════════════════════════════════════════════════════════════ */

/** "tabla" → "\"tabla\"". Las comillas internas se duplican; así se cita en SQL. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/* ── Codificación de celdas ──────────────────────────────────────────────────
   Las sentencias corren con `raw(true)` + `safeIntegers(true)`, así que cada
   valor llega como lo guardó SQLite: INTEGER → BigInt, REAL → number, TEXT →
   string, BLOB → Buffer, NULL → null. Eso permite distinguir 5 de 5.0, que es
   justo lo que un visor tiene que mostrar.

   Para no mandar un objeto por celda, el formato es compacto y se lee así:
     null                  NULL
     number entero         INTEGER dentro del rango seguro de JS
     number con decimales  REAL
     { i: '…' }            INTEGER fuera del rango seguro (como texto, exacto)
     { r: n }              REAL de valor entero (5.0): sin la marca sería un 5
     string                TEXT completo
     { t: '…', n }         TEXT recortado: primeros TEXT_HEAD caracteres, n total
     { b: n, h, m }        BLOB de n bytes: los primeros BLOB_HEAD (h) y su tipo
                           detectado por los bytes mágicos (m), si se reconoce

   Recortar texto y blobs no es opcional: una columna con documentos de 2 MB
   haría viajar cientos de megas por página. El valor entero se pide aparte,
   celda por celda, cuando el inspector lo necesita. */
const TEXT_HEAD = 2000;
const BLOB_HEAD = 64;
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

const MAGIC = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/bmp', [0x42, 0x4d]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
  ['application/gzip', [0x1f, 0x8b]],
  ['application/x-sqlite3', [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]],
];

/** El tipo de un blob por sus primeros bytes, o null. */
function sniffMime(buf) {
  if (!buf || buf.length < 2) return null;
  for (const [mime, sig] of MAGIC) {
    if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) return mime;
  }
  // WEBP: "RIFF" .... "WEBP"
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function encodeValue(v, { textMax = TEXT_HEAD, blobHead = BLOB_HEAD } = {}) {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'bigint':
      return v >= SAFE_MIN && v <= SAFE_MAX ? Number(v) : { i: v.toString() };
    case 'number':
      return Number.isInteger(v) ? { r: v } : v;
    case 'string':
      return v.length > textMax ? { t: v.slice(0, textMax), n: v.length } : v;
    default:
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        const head = blobHead === Infinity ? buf : buf.subarray(0, blobHead);
        // Copia a un Uint8Array propio: un subarray arrastra el buffer entero
        // por el structured clone, y eso es justo lo que el recorte evita.
        return { b: buf.length, h: new Uint8Array(head), m: sniffMime(buf) };
      }
      return String(v);
  }
}

function encodeRow(row, opts) {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; i++) out[i] = encodeValue(row[i], opts);
  return out;
}

/* ── El SELECT de una tabla ──────────────────────────────────────────────────
   Orden y filtro llegan del renderer, así que nada de eso se interpola sin
   pasar por acá: la columna de orden tiene que existir en la tabla (se valida
   contra la lista real, no se cita a ciegas) y el texto del filtro viaja
   siempre como parámetro.

   El filtro busca en TODAS las columnas a la vez, como un buscador: CAST a
   TEXT + LIKE. Es lento en tablas de millones de filas, y está bien: es lo
   que uno espera de "buscar en la tabla", y el conteo se pide aparte para que
   la primera página no lo espere. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildWhere(columns, filter) {
  const q = String(filter ?? '').trim();
  if (!q || !columns.length) return { where: '', params: {} };
  const parts = columns.map((c) => `CAST(${quoteIdent(c)} AS TEXT) LIKE @q ESCAPE '\\'`);
  return { where: ` WHERE (${parts.join(' OR ')})`, params: { q: `%${escapeLike(q)}%` } };
}

/**
 * @param {object} o
 * @param {string} o.table
 * @param {string[]} o.columns      columnas reales, para validar el orden
 * @param {{column:string, dir:'asc'|'desc'}|null} [o.sort]
 * @param {string} [o.filter]
 * @param {boolean} [o.rowid]       si la tabla tiene rowid, se trae primero
 */
function buildSelect({ table, columns, sort = null, filter = '', rowid = false }) {
  const t = quoteIdent(table);
  const { where, params } = buildWhere(columns, filter);

  let order = '';
  if (sort && columns.includes(sort.column)) {
    order = ` ORDER BY ${quoteIdent(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    // Desempate estable: sin él, dos páginas de un orden con valores repetidos
    // pueden traer la misma fila dos veces y perder otra.
    if (rowid) order += ', _rowid_';
  } else if (sort) {
    throw new Error(`No existe la columna ${sort.column}`);
  }

  const cols = rowid ? '_rowid_, *' : '*';
  return {
    sql: `SELECT ${cols} FROM ${t}${where}${order} LIMIT @limit OFFSET @offset`,
    countSql: `SELECT count(*) FROM ${t}${where}`,
    params,
  };
}

/** Saca el `;` final y los espacios: prepare() no acepta nada después de él. */
function cleanSql(sql) {
  return String(sql ?? '').trim().replace(/(;\s*)+$/, '').trim();
}

/* ── Exportación ─────────────────────────────────────────────────────────────
   El valor que se escribe al archivo es el valor REAL, sin recortes ni marcas:
   esto recibe lo que devuelve better-sqlite3, no lo codificado para IPC. */
function csvField(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'bigint') s = v.toString();
  else if (typeof v === 'number') s = Number.isInteger(v) ? v.toFixed(1) : String(v);
  else if (Buffer.isBuffer(v)) s = `\\x${v.toString('hex')}`;
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function jsonValue(v) {
  if (typeof v === 'bigint') {
    return v >= SAFE_MIN && v <= SAFE_MAX ? Number(v) : v.toString();
  }
  if (Buffer.isBuffer(v)) return { $blob: v.toString('base64') };
  return v;
}

module.exports = {
  TEXT_HEAD, BLOB_HEAD,
  quoteIdent, sniffMime, encodeValue, encodeRow,
  escapeLike, buildWhere, buildSelect, cleanSql,
  csvField, jsonValue,
};
