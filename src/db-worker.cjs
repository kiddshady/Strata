'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — el proceso de la base
   better-sqlite3 es sincrónico: un COUNT(*) sobre una tabla de diez millones
   de filas bloquea el hilo donde corre. En el proceso principal eso congela la
   ventana entera (no se puede ni arrastrar), así que la base vive acá, en un
   PROCESO propio (utilityProcess de Electron).

   Proceso y no hilo, a propósito: un worker_thread no se puede matar mientras
   SQLite está adentro de sqlite3_step — terminate() espera a que el código
   nativo devuelva el control, y una consulta recursiva sin fin no lo devuelve
   nunca. better-sqlite3 no expone sqlite3_interrupt(). A un proceso, en
   cambio, el sistema lo mata siempre: cancelar es matarlo y levantar otro
   (ver db.cjs).

   Protocolo: llega { id, op, args }, sale { id, ok, data } o { id, ok:false,
   error }. Un mensaje por vez, en orden — no hay concurrencia interna, y eso
   es lo que hace predecible qué respuesta es de qué pedido.

   SOLO LECTURA, por tres lados a la vez:
     · la conexión se abre con `readonly: true` (SQLITE_OPEN_READONLY);
     · `query_only` rechaza cualquier escritura aunque algo la cuele;
     · la consola solo acepta sentencias que SQLite declara lectoras
       (`stmt.reader && stmt.readonly`), antes de ejecutarlas.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const R = require('./sqlread.cjs');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Filas que se materializan de una consulta libre. Más que esto, se avisa. */
const QUERY_CAP = 100_000;
/** Lo máximo que se manda de UNA celda cuando el inspector la pide entera. */
const CELL_CAP = 32 * 1024 * 1024;

/** @type {Database.Database | null} */
let db = null;
let file = null;
/** Resultados de consultas, servidos por páginas. Solo se guarda el último. */
let result = null;
let resultSeq = 0;

/* ── Utilidades ──────────────────────────────────────────────────────────── */

function need() {
  if (!db) throw new Error('No hay ninguna base abierta');
  return db;
}

function prep(sql) {
  const s = need().prepare(sql);
  if (s.reader) { s.raw(true); s.safeIntegers(true); }
  return s;
}

function scalar(sql, params) {
  const s = need().prepare(sql);
  s.pluck(true);
  return params ? s.get(params) : s.get();
}

function pragma(name) {
  try { return need().pragma(name, { simple: true }); } catch { return null; }
}

/** Nombres de columna de una tabla o vista, cacheados hasta la próxima apertura. */
const colCache = new Map();
function colNames(table) {
  let c = colCache.get(table);
  if (!c) {
    c = prep(`SELECT * FROM ${R.quoteIdent(table)}`).columns().map((x) => x.name);
    colCache.set(table, c);
  }
  return c;
}

function isSQLite(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(16);
    return fs.readSync(fd, buf, 0, 16, 0) === 16 && buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fileInfo() {
  const st = fs.statSync(file);
  // El WAL es parte de la base: una base en modo WAL recién escrita puede
  // tener casi todo su contenido ahí y un .db de 4 kB.
  let wal = 0;
  try { wal = fs.statSync(`${file}-wal`).size; } catch { /* no hay WAL */ }
  return { path: file, name: path.basename(file), size: st.size, wal, mtime: st.mtimeMs };
}

/* ── Catálogo ────────────────────────────────────────────────────────────── */

/** table_list de cada tabla: si es virtual, sombra, sin rowid o strict. */
function tableList() {
  const map = new Map();
  try {
    for (const t of need().prepare('PRAGMA main.table_list').all()) map.set(t.name, t);
  } catch { /* SQLite < 3.37: sin detalle, todo cuenta como tabla común */ }
  return map;
}

function objectKind(o, tl) {
  if (o.type !== 'table') return o.type;
  if (o.name.startsWith('sqlite_')) return 'internal';
  const t = tl.get(o.name);
  if (t?.type === 'shadow') return 'internal';
  if (t?.type === 'virtual' || /^\s*CREATE\s+VIRTUAL/i.test(o.sql || '')) return 'virtual';
  return 'table';
}

function schema() {
  const tl = tableList();
  const rows = need().prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view', 'index', 'trigger')
    ORDER BY name COLLATE NOCASE
  `).all();
  return rows.map((o) => {
    const t = tl.get(o.name);
    return {
      type: o.type,
      kind: objectKind(o, tl),
      name: o.name,
      table: o.tableName,
      sql: o.sql,
      // Los índices automáticos (UNIQUE, PRIMARY KEY no-entera) no tienen sql.
      auto: o.type === 'index' && !o.sql,
      withoutRowid: !!t?.wr,
      strict: !!t?.strict,
      ncol: t?.ncol ?? null,
    };
  });
}

/** Filas de cada tabla. Aparte del esquema: en una base grande tarda. */
function counts(names) {
  const out = {};
  for (const n of names) {
    try { out[n] = Number(scalar(`SELECT count(*) FROM ${R.quoteIdent(n)}`)); }
    catch { out[n] = null; }
  }
  return out;
}

function overview() {
  const pageSize = pragma('page_size');
  const pageCount = pragma('page_count');
  return {
    file: fileInfo(),
    sqlite: scalar('SELECT sqlite_version()'),
    encoding: pragma('encoding'),
    journal: pragma('journal_mode'),
    pageSize,
    pageCount,
    freePages: pragma('freelist_count'),
    userVersion: pragma('user_version'),
    applicationId: pragma('application_id'),
    autoVacuum: ['none', 'full', 'incremental'][pragma('auto_vacuum')] ?? null,
    schemaVersion: pragma('schema_version'),
  };
}

/* ── Estructura de un objeto ─────────────────────────────────────────────── */

function objectRow(name) {
  const o = need().prepare('SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name = ?').get(name);
  if (!o) throw new Error(`No existe el objeto ${name}`);
  return o;
}

function columnsOf(name) {
  // table_xinfo y no table_info: muestra también las columnas generadas y las
  // ocultas de las tablas virtuales, con `hidden` diciendo cuál es cuál.
  const q = R.quoteIdent(name);
  try { return need().prepare(`PRAGMA table_xinfo(${q})`).all(); }
  catch { return need().prepare(`PRAGMA table_info(${q})`).all(); }
}

function structure(name) {
  const d = need();
  const o = objectRow(name);
  const q = R.quoteIdent(name);
  const out = { type: o.type, name: o.name, table: o.tableName, sql: o.sql };

  if (o.type === 'table' || o.type === 'view') {
    out.columns = columnsOf(name).map((c) => ({
      cid: c.cid, name: c.name, type: c.type || '', notnull: !!c.notnull,
      dflt: c.dflt_value, pk: c.pk, hidden: c.hidden ?? 0,
    }));
  }
  if (o.type === 'table') {
    out.foreignKeys = d.prepare(`PRAGMA foreign_key_list(${q})`).all().map((f) => ({
      id: f.id, from: f.from, table: f.table, to: f.to, onUpdate: f.on_update, onDelete: f.on_delete,
    }));
    out.indexes = d.prepare(`PRAGMA index_list(${q})`).all().map((ix) => ({
      name: ix.name, unique: !!ix.unique, origin: ix.origin, partial: !!ix.partial,
      columns: indexColumns(ix.name),
    }));
  }
  if (o.type === 'table' || o.type === 'view') {
    // Las vistas también tienen triggers: los INSTEAD OF.
    out.triggers = d.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`)
      .pluck(true).all(name);
  }
  if (o.type === 'index') {
    const ix = d.prepare(`PRAGMA index_list(${R.quoteIdent(o.tableName)})`).all().find((i) => i.name === name);
    out.unique = !!ix?.unique;
    out.origin = ix?.origin ?? 'c';
    out.partial = !!ix?.partial;
    out.columns = indexColumns(name);
  }
  return out;
}

function indexColumns(name) {
  return need().prepare(`PRAGMA index_xinfo(${R.quoteIdent(name)})`).all()
    .filter((c) => c.key)
    .map((c) => ({ name: c.name ?? (c.cid === -2 ? '(expresión)' : '_rowid_'), desc: !!c.desc, coll: c.coll }));
}

/* ── Datos de una tabla o vista ──────────────────────────────────────────── */

/** Lo que el grid necesita saber antes de pedir filas. */
function meta(name) {
  const o = objectRow(name);
  const tl = tableList();
  const hasRowid = o.type === 'table' && !tl.get(name)?.wr && objectKind(o, tl) !== 'virtual';
  const s = prep(`SELECT * FROM ${R.quoteIdent(name)}`);
  const info = new Map(columnsOf(name).map((c) => [c.name, c]));
  const columns = s.columns().map((c) => {
    const i = info.get(c.name);
    return { name: c.name, type: c.type || i?.type || '', pk: i?.pk || 0, notnull: !!i?.notnull };
  });
  return { name, type: o.type, hasRowid, columns };
}

function rows({ table, offset = 0, limit = 200, sort = null, filter = '', rowid = false }) {
  const cols = colNames(table);
  const q = R.buildSelect({ table, columns: cols, sort, filter, rowid });
  const data = prep(q.sql).all({ ...q.params, limit: Math.min(1000, limit | 0), offset: Math.max(0, offset | 0) });
  if (!rowid) return { rows: data.map((r) => R.encodeRow(r)) };
  return {
    rowids: data.map((r) => String(r[0])),
    rows: data.map((r) => R.encodeRow(r.slice(1))),
  };
}

function count({ table, filter = '' }) {
  const cols = colNames(table);
  const q = R.buildSelect({ table, columns: cols, filter });
  return Number(scalar(q.countSql, q.params));
}

/** Una celda entera, sin recortes, para el inspector. */
function cell({ table, rowid, column }) {
  const cols = colNames(table);
  if (!cols.includes(column)) throw new Error(`No existe la columna ${column}`);
  const s = need().prepare(
    `SELECT length(${R.quoteIdent(column)}) AS n FROM ${R.quoteIdent(table)} WHERE _rowid_ = ?`);
  const len = s.pluck(true).get(BigInt(rowid));
  if (len > CELL_CAP) throw new Error(`La celda pesa demasiado para mostrarla entera (${len} bytes)`);
  const v = prep(`SELECT ${R.quoteIdent(column)} FROM ${R.quoteIdent(table)} WHERE _rowid_ = ?`).get(BigInt(rowid));
  return v ? R.encodeValue(v[0], { textMax: Infinity, blobHead: Infinity }) : null;
}

/* ── Consola ─────────────────────────────────────────────────────────────── */

function query(sql) {
  const text = R.cleanSql(sql);
  if (!text) throw new Error('La consulta está vacía');
  let s;
  try { s = need().prepare(text); }
  catch (err) {
    if (/more than one statement/i.test(err.message)) throw new Error('Una sola sentencia por vez');
    throw err;
  }
  if (!s.reader || !s.readonly) {
    throw new Error('Strata es de solo lectura: la consola solo corre sentencias que devuelven filas (SELECT, WITH, PRAGMA de lectura, EXPLAIN)');
  }
  s.raw(true); s.safeIntegers(true);

  const t0 = process.hrtime.bigint();
  const out = [];
  let truncated = false;
  for (const r of s.iterate()) {
    if (out.length >= QUERY_CAP) { truncated = true; break; }
    out.push(R.encodeRow(r));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  // Los nombres pueden repetirse (un JOIN sin alias trae dos "id"): por eso
  // las filas viajan como arrays y las columnas como lista, nunca como objeto.
  const columns = s.columns().map((c) => ({ name: c.name, type: c.type || '', table: c.table }));
  result = { id: ++resultSeq, sql: text, columns, rows: out };
  return { id: result.id, columns, total: out.length, truncated, cap: QUERY_CAP, ms, rows: out.slice(0, 200) };
}

function queryPage({ id, offset = 0, limit = 200 }) {
  if (!result || result.id !== id) throw new Error('El resultado ya no está disponible: volvé a ejecutar la consulta');
  return { rows: result.rows.slice(offset, offset + limit) };
}

/* ── Exportar ────────────────────────────────────────────────────────────────
   Se escribe acá, en el worker, fila por fila: exportar una tabla de un
   millón de filas no puede pasar entera por IPC ni por la memoria del
   renderer. Lo que se escribe son los valores reales, sin recortes. */
function exportTo({ source, format, target }) {
  let stmt; let params = {};
  if (source.table) {
    const cols = colNames(source.table);
    const q = R.buildSelect({ table: source.table, columns: cols, sort: source.sort, filter: source.filter });
    stmt = prep(q.sql.replace(' LIMIT @limit OFFSET @offset', ''));
    params = q.params;
  } else {
    if (!result || result.id !== source.resultId) throw new Error('El resultado ya no está disponible');
    stmt = prep(result.sql);
  }
  const names = stmt.columns().map((c) => c.name);
  const fd = fs.openSync(`${target}.tmp`, 'w');
  let n = 0;
  try {
    const write = (s) => fs.writeSync(fd, s);
    if (format === 'csv') {
      write(`﻿${names.map(R.csvField).join(',')}\r\n`);   // BOM: Excel lo pide para leer UTF-8
      for (const r of stmt.iterate(params)) { write(`${r.map(R.csvField).join(',')}\r\n`); n++; }
    } else {
      write('[');
      for (const r of stmt.iterate(params)) {
        const obj = {};
        names.forEach((c, i) => { obj[c] = R.jsonValue(r[i]); });
        write(`${n ? ',' : ''}\n  ${JSON.stringify(obj)}`);
        n++;
      }
      write(n ? '\n]\n' : ']\n');
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(`${target}.tmp`, target);
  return { rows: n, bytes: fs.statSync(target).size, path: target };
}

/* ── Ciclo de vida ───────────────────────────────────────────────────────── */

function open(p) {
  if (!fs.existsSync(p)) throw new Error(`No existe el archivo: ${p}`);
  if (!fs.statSync(p).isFile()) throw new Error('Eso es una carpeta, no una base');
  if (!isSQLite(p)) throw new Error('El archivo no es una base SQLite (le falta la firma "SQLite format 3")');
  close();
  db = new Database(p, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  file = p;
  // Leer algo de verdad acá: una base cifrada o corrupta pasa la firma pero
  // falla recién en la primera consulta, y mejor que falle al abrir.
  try { db.prepare('SELECT count(*) FROM sqlite_schema').get(); }
  catch (err) { close(); throw new Error(`SQLite no pudo leerla: ${err.message}`); }
  return fileInfo();
}

function close() {
  if (db) { try { db.close(); } catch { /* ya estaba cerrada */ } }
  db = null; file = null; result = null;
  colCache.clear();
  return true;
}

const OPS = {
  open, close, overview, schema, counts, structure, meta, rows, count, cell,
  query, queryPage, export: exportTo,
  info: () => (file ? fileInfo() : null),
};

const port = process.parentPort;
port.on('message', ({ data: { id, op, args = [] } }) => {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`Operación desconocida: ${op}`);
    port.postMessage({ id, ok: true, data: fn(...args) });
  } catch (err) {
    port.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
