'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   La capa de datos entera, contra el worker de verdad (src/db.cjs →
   src/db-worker.cjs → better-sqlite3). Necesita Electron: el better-sqlite3
   instalado está compilado para su ABI. Corre con `npm run test:db`.

   Lo que más importa acá es la promesa de la app: SOLO LECTURA. Al final se
   compara el hash del archivo con el de antes de empezar.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const rejects = async (n, p, re) => {
  try { await p; ok(n, false, '(no falló)'); } catch (err) { ok(n, !re || re.test(err.message), `(${err.message})`); }
};
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-db-'));
const DB = path.join(DIR, 'prueba.db');

function fixture() {
  const Database = require('better-sqlite3');
  const w = new Database(DB);
  w.exec(`
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, email TEXT UNIQUE,
                           edad INTEGER, saldo REAL, bio TEXT, foto BLOB);
    CREATE TABLE etiquetas (clave TEXT PRIMARY KEY, valor TEXT) WITHOUT ROWID;
    CREATE TABLE pedidos (id INTEGER PRIMARY KEY, usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE, total REAL);
    CREATE VIEW adultos AS SELECT id, nombre, edad FROM usuarios WHERE edad >= 18;
    CREATE VIEW dup AS SELECT u.id, p.id FROM usuarios u JOIN pedidos p ON p.usuario = u.id;
    CREATE INDEX idx_nombre ON usuarios(nombre);
    CREATE TRIGGER trg AFTER INSERT ON pedidos BEGIN SELECT 1; END;
    CREATE VIRTUAL TABLE notas USING fts5(texto);
  `);
  const ins = w.prepare('INSERT INTO usuarios (nombre, email, edad, saldo, bio, foto) VALUES (?, ?, ?, ?, ?, ?)');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  for (let i = 1; i <= 250; i++) {
    ins.run(`user ${i}`, i === 5 ? null : `u${i}@x.com`, i % 40, i === 3 ? 5.0 : i * 1.25,
      i === 1 ? 'larguísimo '.repeat(600) : `bio ${i}`, i === 2 ? png : null);
  }
  w.prepare('INSERT INTO pedidos (usuario, total) VALUES (1, 10.5), (1, 20), (2, 7)').run();
  w.prepare("INSERT INTO etiquetas VALUES ('a', 'uno'), ('b', 'dos')").run();
  w.prepare("INSERT INTO notas VALUES ('hola mundo')").run();
  w.prepare('INSERT INTO usuarios (id, nombre) VALUES (9007199254740993, ?)').run('grande');
  w.close();
}

process.on('unhandledRejection', (e) => { console.log('ABORTADO', e); app.exit(3); });
setTimeout(() => { console.log('ABORTADO: timeout'); app.exit(3); }, 60000);

app.whenReady().then(async () => {
  fixture();
  const before = hash(DB);
  const db = require('../src/db.cjs');

  console.log('\n1. Abrir');
  const fake = path.join(DIR, 'falsa.db');
  fs.writeFileSync(fake, 'esto no es una base');
  await rejects('un archivo que no es SQLite se rechaza', db.open(fake), /no es una base SQLite/);
  await rejects('una ruta que no existe se rechaza', db.open(path.join(DIR, 'nada.db')), /No existe/);
  await rejects('una carpeta se rechaza', db.open(DIR), /carpeta/);
  const info = await db.open(DB);
  ok('abre y devuelve nombre y tamaño', info.name === 'prueba.db' && info.size > 0);

  console.log('\n2. Esquema');
  const s = await db.call('schema');
  const kind = (n) => s.find((o) => o.name === n)?.kind;
  ok('tabla común', kind('usuarios') === 'table');
  ok('vista', kind('adultos') === 'view');
  ok('índice', kind('idx_nombre') === 'index');
  ok('trigger', kind('trg') === 'trigger');
  ok('tabla virtual (fts5)', kind('notas') === 'virtual');
  ok('las sombras del fts5 son internas', kind('notas_data') === 'internal');
  ok('sqlite_sequence es interna', kind('sqlite_sequence') === 'internal');
  ok('el índice automático de UNIQUE aparece sin SQL', s.some((o) => o.auto && o.name.startsWith('sqlite_autoindex_usuarios')));
  ok('WITHOUT ROWID se detecta', s.find((o) => o.name === 'etiquetas')?.withoutRowid === true);

  const counts = await db.call('counts', ['usuarios', 'pedidos', 'etiquetas']);
  ok('conteos por tabla', counts.usuarios === 251 && counts.pedidos === 3 && counts.etiquetas === 2, JSON.stringify(counts));

  const ov = await db.call('overview');
  ok('resumen: versión, página, encoding', /^3\./.test(ov.sqlite) && ov.pageSize > 0 && ov.encoding === 'UTF-8');

  console.log('\n3. Estructura');
  const st = await db.call('structure', 'usuarios');
  ok('columnas con tipo y restricciones', st.columns.length === 7 && st.columns[0].pk === 1 && st.columns[1].notnull);
  ok('índices con sus columnas', st.indexes.some((i) => i.name === 'idx_nombre' && i.columns[0].name === 'nombre'));
  ok('el UNIQUE aparece como índice de origen u', st.indexes.some((i) => i.origin === 'u' && i.unique));
  const sp = await db.call('structure', 'pedidos');
  ok('claves foráneas', sp.foreignKeys[0]?.table === 'usuarios' && sp.foreignKeys[0]?.onDelete === 'CASCADE');
  ok('triggers de la tabla', sp.triggers.includes('trg'));
  const si = await db.call('structure', 'idx_nombre');
  ok('ficha de índice', si.columns[0].name === 'nombre' && si.unique === false);

  console.log('\n4. Filas');
  const meta = await db.call('meta', 'usuarios');
  ok('meta: columnas y rowid', meta.hasRowid && meta.columns.map((c) => c.name).join() === 'id,nombre,email,edad,saldo,bio,foto');
  ok('meta: sin rowid para WITHOUT ROWID', !(await db.call('meta', 'etiquetas')).hasRowid);
  ok('meta: sin rowid para una vista', !(await db.call('meta', 'adultos')).hasRowid);

  const p1 = await db.call('rows', { table: 'usuarios', offset: 0, limit: 100, rowid: true });
  ok('primera página', p1.rows.length === 100 && p1.rowids.length === 100 && p1.rowids[0] === '1');
  ok('texto largo llega recortado con su largo', p1.rows[0][5].n === 'larguísimo '.repeat(600).length);
  ok('REAL entero llega marcado', JSON.stringify(p1.rows[2][4]) === '{"r":5}');
  ok('BLOB llega como cabeza + tipo', p1.rows[1][6].b === 208 && p1.rows[1][6].m === 'image/png');
  ok('NULL llega como null', p1.rows[4][2] === null);
  const last = await db.call('rows', { table: 'usuarios', offset: 250, limit: 100, rowid: true });
  ok('INTEGER más allá de 2^53 llega exacto', last.rows[0][0]?.i === '9007199254740993' && last.rowids[0] === '9007199254740993');

  const desc = await db.call('rows', { table: 'usuarios', offset: 0, limit: 3, sort: { column: 'id', dir: 'desc' } });
  ok('orden descendente', desc.rows[0][0]?.i === '9007199254740993' && desc.rows[1][0] === 250);
  await rejects('orden por una columna inventada se rechaza', db.call('rows', { table: 'usuarios', sort: { column: 'nope', dir: 'asc' } }), /No existe la columna/);

  const fr = await db.call('rows', { table: 'usuarios', offset: 0, limit: 50, filter: 'user 1' });
  ok('filtro en todas las columnas', fr.rows.length > 0 && fr.rows.every((r) => r.some((v) => typeof v === 'string' && v.includes('user 1'))));
  const n = await db.call('count', { table: 'usuarios', filter: 'user 1' });
  // "user 1", "user 10"…"user 19" y "user 100"…"user 199"
  ok('conteo con el mismo filtro', n === 111, String(n));
  ok('un % en el filtro es literal, no comodín', (await db.call('count', { table: 'usuarios', filter: '%' })) === 0);

  const dup = await db.call('meta', 'dup');
  ok('columnas repetidas no se pisan (JOIN sin alias)', dup.columns.length === 2);

  const full = await db.call('cell', { table: 'usuarios', rowid: '1', column: 'bio' });
  ok('celda entera por rowid', typeof full === 'string' && full.length === 'larguísimo '.repeat(600).length);
  const img = await db.call('cell', { table: 'usuarios', rowid: '2', column: 'foto' });
  ok('blob entero por rowid', img.b === 208 && img.h.length === 208);

  console.log('\n5. Consola: solo lectura');
  const q = await db.call('query', 'SELECT id, id FROM usuarios WHERE id <= 10 ORDER BY id DESC;');
  ok('SELECT con columnas repetidas', q.columns.length === 2 && q.total === 10 && q.rows[0][0] === 10);
  ok('mide el tiempo', typeof q.ms === 'number');
  const pg = await db.call('queryPage', { id: q.id, offset: 5, limit: 3 });
  ok('páginas del resultado', pg.rows.length === 3 && pg.rows[0][0] === 5);
  ok('PRAGMA de lectura corre', (await db.call('query', 'PRAGMA table_info(usuarios)')).total === 7);
  await rejects('INSERT se rechaza antes de correr', db.call('query', "INSERT INTO etiquetas VALUES ('z','z')"), /solo lectura/);
  await rejects('UPDATE se rechaza', db.call('query', 'UPDATE usuarios SET edad = 0'), /solo lectura/);
  await rejects('DROP se rechaza', db.call('query', 'DROP TABLE usuarios'), /solo lectura/);
  await rejects('ATTACH se rechaza', db.call('query', "ATTACH 'x.db' AS x"), /solo lectura/);
  await rejects('dos sentencias se rechazan', db.call('query', 'SELECT 1; DELETE FROM usuarios'), /Una sola sentencia/);
  await rejects('un error de SQL vuelve con el mensaje de SQLite', db.call('query', 'SELECT * FROM no_existe'), /no such table/);

  console.log('\n6. Cancelar');
  const eterna = db.call('query', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c');
  // El handler va ya: la promesa se rechaza durante cancel(), antes del assert.
  const cortada = eterna.then(() => null, (err) => err);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const reabierta = await db.cancel();
  ok('la consulta eterna se corta', (await cortada)?.message === 'Cancelado');
  ok('y se corta rápido', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  ok('la base queda abierta otra vez', reabierta?.name === 'prueba.db');
  ok('y responde', (await db.call('counts', ['pedidos'])).pedidos === 3);

  console.log('\n7. Exportar');
  const csv = path.join(DIR, 'out.csv');
  const e1 = await db.call('export', { source: { table: 'pedidos', sort: { column: 'total', dir: 'desc' } }, format: 'csv', target: csv });
  const csvText = fs.readFileSync(csv, 'utf8');
  ok('CSV: filas y encabezado', e1.rows === 3 && csvText.startsWith('﻿id,usuario,total\r\n'), JSON.stringify(csvText.slice(0, 40)));
  ok('CSV: respeta el orden y el REAL entero', csvText.split('\r\n')[1] === '2,1,20.0', csvText.split('\r\n')[1]);
  const json = path.join(DIR, 'out.json');
  const qq = await db.call('query', 'SELECT id, foto FROM usuarios WHERE id = 2');
  await db.call('export', { source: { resultId: qq.id }, format: 'json', target: json });
  const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
  ok('JSON de un resultado, con el blob en base64', parsed[0].id === 2 && Buffer.from(parsed[0].foto.$blob, 'base64').length === 208);

  console.log('\n8. La promesa');
  await db.close();
  db.shutdown();
  ok('la base NO cambió ni un byte', hash(DB) === before);
  ok('ni dejó un -wal ni un -journal', !fs.existsSync(`${DB}-wal`) && !fs.existsSync(`${DB}-journal`));

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  app.exit(fail ? 1 : 0);
});
