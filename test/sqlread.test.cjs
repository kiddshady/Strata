'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   La parte pura de la lectura: citar, armar el SELECT y codificar celdas.
   Corre con node pelado (`npm test`): no abre ninguna base.
   ═══════════════════════════════════════════════════════════════════════════ */

const R = require('../src/sqlread.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const eq = (n, got, want) => ok(`${n} → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), `(dio ${JSON.stringify(got)})`);

console.log('\n1. Identificadores');
eq('nombre simple', R.quoteIdent('clientes'), '"clientes"');
eq('comillas adentro se duplican', R.quoteIdent('a"b'), '"a""b"');
eq('espacios y acentos pasan tal cual', R.quoteIdent('mis datos ñ'), '"mis datos ñ"');

console.log('\n2. SELECT de una tabla');
const cols = ['id', 'nombre', 'saldo'];
const plain = R.buildSelect({ table: 't', columns: cols });
eq('sin orden ni filtro', plain.sql, 'SELECT * FROM "t" LIMIT @limit OFFSET @offset');
const sorted = R.buildSelect({ table: 't', columns: cols, sort: { column: 'saldo', dir: 'desc' }, rowid: true });
ok('con rowid trae _rowid_ primero', sorted.sql.startsWith('SELECT _rowid_, * FROM'));
ok('el orden desempata por rowid', sorted.sql.includes('ORDER BY "saldo" DESC, _rowid_'), sorted.sql);
let threw = false;
try { R.buildSelect({ table: 't', columns: cols, sort: { column: 'x; DROP TABLE t', dir: 'asc' } }); } catch { threw = true; }
ok('una columna de orden que no existe se rechaza (no se cita a ciegas)', threw);

const f = R.buildSelect({ table: 't', columns: cols, filter: '50%_off' });
ok('el filtro busca en todas las columnas', (f.sql.match(/LIKE @q/g) || []).length === 3, f.sql);
eq('el texto del filtro viaja como parámetro, con % y _ escapados', f.params.q, '%50\\%\\_off%');
ok('el conteo usa el mismo WHERE', f.countSql.includes('WHERE') && f.countSql.startsWith('SELECT count(*)'));
ok('un filtro de solo espacios no filtra', !R.buildSelect({ table: 't', columns: cols, filter: '   ' }).sql.includes('WHERE'));

console.log('\n3. Celdas: el tipo de SQLite sobrevive al viaje');
eq('NULL', R.encodeValue(null), null);
eq('INTEGER chico → number', R.encodeValue(42n), 42);
eq('INTEGER enorme → texto exacto', R.encodeValue(9007199254740993n), { i: '9007199254740993' });
eq('REAL con decimales → number', R.encodeValue(1.5), 1.5);
eq('REAL de valor entero → marcado (5.0 no es 5)', R.encodeValue(5), { r: 5 });
eq('TEXT corto → tal cual', R.encodeValue('hola'), 'hola');
const long = R.encodeValue('x'.repeat(5000));
ok('TEXT largo → recortado con su largo real', long.t.length === R.TEXT_HEAD && long.n === 5000);
eq('sin límite (para el inspector) no recorta', R.encodeValue('x'.repeat(5000), { textMax: Infinity }).length, 5000);

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500)]);
const b = R.encodeValue(png);
ok('BLOB → tamaño real', b.b === 508);
ok('BLOB → solo la cabeza viaja', b.h.length === R.BLOB_HEAD && b.h instanceof Uint8Array);
eq('BLOB → tipo por los bytes mágicos', b.m, 'image/png');
eq('BLOB desconocido → sin tipo', R.encodeValue(Buffer.from([1, 2, 3])).m, null);
ok('la cabeza es una copia, no una vista del buffer entero', b.h.buffer.byteLength === R.BLOB_HEAD);

console.log('\n4. SQL de la consola');
eq('saca el ; final', R.cleanSql('SELECT 1;  '), 'SELECT 1');
eq('y varios', R.cleanSql('SELECT 1;;\n'), 'SELECT 1');

console.log('\n5. Exportar');
eq('CSV: NULL vacío', R.csvField(null), '');
eq('CSV: comillas y comas se escapan', R.csvField('a,"b"'), '"a,""b"""');
eq('CSV: REAL entero conserva el .0', R.csvField(5), '5.0');
eq('CSV: INTEGER enorme exacto', R.csvField(9007199254740993n), '9007199254740993');
eq('CSV: BLOB en hex', R.csvField(Buffer.from([0xab, 0x01])), '\\xab01');
eq('JSON: BLOB en base64', R.jsonValue(Buffer.from('hi')), { $blob: 'aGk=' });

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
process.exit(fail ? 1 : 0);
