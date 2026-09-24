/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer de Strata: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron). Crea una SQLite con de
   todo, la abre por el hook window.__strata —el diálogo nativo no se puede
   automatizar— y recorre: inicio, resumen, rail, grid virtual, orden, filtro,
   inspector, estructura, índices, consola y cierre.

   La regla que guía (de Opal): **medí dónde CAE una cosa, no solo si existe**.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const W = 1440; const H = 900;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-smoke-'));
const DB_PATH = path.join(TMP, 'smoke.db');
// Datos de la app aparte: el smoke no ensucia las recientes de verdad.
process.env.STRATA_DATA = path.join(TMP, 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 120s'), 120000);

/* 5000 filas: el grid tiene que dibujar solo las que se ven. */
function fixture() {
  const Database = require('better-sqlite3');
  const d = new Database(DB_PATH);
  d.exec(`
    CREATE TABLE muestras (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, valor REAL, nota TEXT, datos BLOB);
    CREATE TABLE lotes (id INTEGER PRIMARY KEY, muestra INTEGER REFERENCES muestras(id), fecha TEXT);
    CREATE VIEW resumen AS SELECT count(*) AS total, sum(valor) AS suma FROM muestras;
    CREATE INDEX idx_nombre ON muestras(nombre);
    CREATE TRIGGER trg AFTER INSERT ON muestras BEGIN SELECT 1; END;
  `);
  const ins = d.prepare('INSERT INTO muestras (nombre, valor, nota, datos) VALUES (?, ?, ?, ?)');
  d.transaction(() => {
    for (let i = 1; i <= 5000; i++) {
      ins.run(`muestra ${i}`, i * 1.5, i === 7 ? null : i === 2 ? '{"a":1,"b":[1,2]}' : `nota ${i}`,
        i === 3 ? Buffer.from([1, 2, 3, 255]) : null);
    }
  })();
  d.prepare("INSERT INTO lotes (muestra, fecha) VALUES (1, '2026-01-01')").run();
  d.close();
}

app.whenReady().then(async () => {
  fixture();
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();
  // El updater registra sus canales aunque no corra (en dev no actualiza nada).
  let winRef = null;
  require(path.join(ROOT, 'src', 'updater.cjs')).init(() => winRef);

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  winRef = win;
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(`${e.level}: ${e.message}`); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(1800);

  const js = (c) => win.webContents.executeJavaScript(c);
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const rect = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);
  const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);

  console.log('\n1. Arranque, sin base');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('el inicio muestra la versión', /^v\d+\.\d+\.\d+$/.test(await text('.st-hero__ver') || ''), await text('.st-hero__ver'));
  ok('el inicio invita a abrir', !!(await js(`document.querySelector('.st-hero [data-action="open"]')`)));
  const rail0 = await rect('.op-rail');
  ok('sin base, el rail está plegado', rail0 && rail0.w < 1, JSON.stringify(rail0));
  ok('la statusbar dice que no hay base', (await text('#stat-db')) === 'Sin base abierta');

  console.log('\n2. Abrir (por el hook, sin diálogo)');
  ok('la base abrió', await js(`window.__strata.openDatabase(${JSON.stringify(DB_PATH)}).then(r => !!r)`));
  await sleep(900);
  const rail1 = await rect('.op-rail');
  ok('el rail se desplegó', rail1 && Math.round(rail1.w) === 224, JSON.stringify(rail1));
  ok('abre en el resumen', await js(`!!document.querySelector('.st-stats')`));
  ok('el resumen cuenta todas las filas', (await text('#ov-rows'))?.replace(/\D/g, '') === '5001', await text('#ov-rows'));
  ok('el rail agrupa tablas, vistas, índices y triggers',
    await js(`['table','view','index','trigger'].every(k => document.querySelector('[data-group="' + k + '"]'))`));
  ok('el contador del rail abrevia sin decimales vacíos', (await text('#rail-nav [data-count="muestras"]')) === '5k', await text('#rail-nav [data-count="muestras"]'));
  ok('la statusbar nombra la base y su encoding',
    (await text('#stat-db')) === 'smoke.db' && (await text('#stat-enc')) === 'UTF-8');
  ok('el título de la ventana lleva la base', (await js('document.title')).startsWith('smoke.db'));

  console.log('\n3. Grid virtual');
  await click('#rail-nav [data-obj="muestras"]');
  await sleep(900);
  ok('la tabla abre en Datos', await js(`!!document.querySelector('.st-grid .st-row')`));
  const drawn = await js(`document.querySelectorAll('.st-grid .st-row').length`);
  ok('dibuja solo las filas visibles (no las 5000)', drawn > 10 && drawn < 80, String(drawn));
  const head = await rect('.op-viewhead__title');
  const grid = await rect('.st-grid');
  const tabs = await rect('.st-tabs .op-tab');
  ok('el grid arranca en la columna del título (sin doble sangría)', grid && head && Math.abs(grid.x - head.x) <= 1,
    `grid ${grid?.x} · título ${head?.x}`);
  ok('y las pestañas también', tabs && head && Math.abs(tabs.x - head.x) <= 1, `tabs ${tabs?.x} · título ${head?.x}`);
  ok('el encabezado muestra el tipo de la columna', (await text('.st-th[data-c="2"] .st-th__type')) === 'REAL');
  ok('el NULL se ve como NULL', await js(`[...document.querySelectorAll('.st-v--null')].some(e => e.textContent === 'NULL')`));
  ok('el BLOB se ve con su tamaño', await js(`[...document.querySelectorAll('.st-v--blob')].some(e => /BLOB · 4 B/.test(e.textContent))`));
  ok('los números se alinean a la derecha', await js(`getComputedStyle(document.querySelector('.st-td--real')).textAlign === 'right'`));
  const pkHead = await js(`(() => { const th = document.querySelector('.st-th[data-c="0"]'); const n = th.querySelector('.st-th__name');
    const t = th.querySelector('.st-th__type'); return { n: [n.scrollWidth, n.clientWidth], t: t ? [t.scrollWidth, t.clientWidth] : null, th: th.clientWidth }; })()`);
  ok('el nombre y el tipo de la columna PK no quedan recortados',
    pkHead.n[0] <= pkHead.n[1] + 1 && (!pkHead.t || pkHead.t[0] <= pkHead.t[1] + 1), JSON.stringify(pkHead));

  await js(`(() => { const g = document.querySelector('.st-grid'); g.scrollTop = g.scrollHeight; })()`);
  await sleep(700);
  ok('al fondo llegan las últimas filas', await js(`[...document.querySelectorAll('.st-row .st-gc--gutter')].some(e => e.textContent === '5000')`));
  const lastRow = await js(`(() => { const rows = [...document.querySelectorAll('.st-row')];
    const r = rows.find(x => x.querySelector('.st-gc--gutter').textContent === '5000').getBoundingClientRect();
    const g = document.querySelector('.st-grid').getBoundingClientRect(); return { b: r.bottom, gb: g.bottom }; })()`);
  ok('y la última fila cae dentro del grid, no cortada', lastRow.b <= lastRow.gb + 1, JSON.stringify(lastRow));

  console.log('\n4. Orden y filtro');
  await click('.st-th[data-c="0"] .st-th__name');
  await sleep(700);
  ok('click en el encabezado ordena', await js(`document.querySelector('.st-th[data-c="0"]').classList.contains('is-sorted')`));
  ok('aparece el chip del orden', !!(await js(`document.querySelector('[data-role="unsort"]')`)));
  await click('.st-th[data-c="0"] .st-th__name');
  await sleep(700);
  ok('segundo click invierte: arriba la fila 5000', await js(`document.querySelector('.st-row[data-i="0"] .st-td[data-c="0"]')?.textContent === '5000'`));
  await click('[data-role="unsort"]');
  await sleep(600);

  await js(`(() => { const f = document.querySelector('[data-role="filter"]'); f.value = 'muestra 4213'; f.dispatchEvent(new Event('input')); })()`);
  await sleep(1100);
  ok('el filtro reduce el total', (await text('[data-role="status"]')) === '1 fila', await text('[data-role="status"]'));
  const nrows = await js(`document.querySelectorAll('.st-grid .st-row').length`);
  ok('y el grid lo refleja', nrows === 1 && (await text('.st-row .st-td[data-c="1"]')) === 'muestra 4213', String(nrows));
  await js(`(() => { const f = document.querySelector('[data-role="filter"]'); f.value = 'zzz no existe'; f.dispatchEvent(new Event('input')); })()`);
  await sleep(1000);
  ok('sin resultados muestra el vacío', await js(`document.querySelector('.st-grid').classList.contains('is-empty')`));
  await js(`(() => { const f = document.querySelector('[data-role="filter"]'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
  await sleep(900);

  console.log('\n5. Cursor e inspector');
  await js(`document.querySelector('.st-grid').focus()`);
  key('Down'); await sleep(120); key('Down'); await sleep(120); key('Right'); await sleep(120); key('Right'); await sleep(120); key('Right');
  await sleep(500);
  ok('las flechas mueven el cursor', await js(`document.querySelector('.st-row[data-i="1"] .st-td.is-cursor')?.dataset.c === '3'`));
  ok('la statusbar de la tabla dice qué fila', /fila 2 de 5\.000/.test(await text('[data-role="status"]')), await text('[data-role="status"]'));
  ok('el inspector muestra la fila', /2\s+·\s+rowid 2/.test(await text('.st-insp__title')), await text('.st-insp__title'));
  ok('el JSON de la celda se ve indentado', await js(`!!document.querySelector('.st-field.is-focus .st-code--json .st-tk-key')`));
  ok('el valor del inspector se puede seleccionar', await js(`getComputedStyle(document.querySelector('.st-field__val .st-code')).userSelect === 'text'`));
  const insp = await rect('.st-insp');
  ok('el inspector llega al borde de la ventana', insp && Math.abs(insp.r - W) <= 1, JSON.stringify(insp));

  await js(`(() => { const td = document.querySelector('.st-row[data-i="1"] .st-td[data-c="1"]');
    td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 300 })); })()`);
  await sleep(400);
  ok('click derecho abre el menú de la celda', await js(`[...document.querySelectorAll('.op-menuitem')].some(m => m.textContent.includes('Copiar fila como JSON'))`));
  const menu = await rect('.op-menu');
  ok('y el menú cae junto al puntero', menu && Math.abs(menu.x - 600) < 20 && Math.abs(menu.y - 300) < 20, JSON.stringify(menu));
  key('Escape');
  await sleep(400);

  console.log('\n6. Estructura');
  await click('[data-value="estructura"]');
  await sleep(900);
  ok('lista las 5 columnas', await js(`document.querySelectorAll('.st-coltable tbody tr').length === 5`));
  ok('marca la PRIMARY KEY', await js(`[...document.querySelectorAll('.st-coltable .op-chip')].some(c => c.textContent === 'PRIMARY KEY')`));
  ok('muestra el índice', await js(`!!document.querySelector('.st-structure [data-obj="idx_nombre"]')`));
  ok('el SQL viene resaltado', await js(`!!document.querySelector('.st-code--sql .st-tk-kw')`));
  await click('.st-structure [data-obj="idx_nombre"]');
  await sleep(700);
  ok('un índice abre su ficha', (await text('.op-viewhead__title')) === 'idx_nombre' && /CREATE INDEX/.test(await text('.st-code--sql')));
  ok('el rail ilumina el índice', await js(`document.querySelector('#rail-nav .st-obj.is-active')?.dataset.obj === 'idx_nombre'`));

  console.log('\n7. Vista');
  await click('#rail-nav [data-obj="resumen"]');
  await sleep(900);
  ok('recuerda la pestaña de la última tabla (Estructura)', await js(`document.querySelector('.op-tab.is-active')?.dataset.value === 'estructura'`));
  ok('una vista lista sus columnas', await js(`document.querySelectorAll('.st-coltable tbody tr').length === 2`));
  await click('[data-value="datos"]');
  await sleep(900);
  ok('y en Datos abre como grid', await js(`document.querySelectorAll('.st-grid .st-row').length === 1`));

  console.log('\n8. Consola');
  await click('[data-goto="consulta"]');
  await sleep(700);
  ok('la consola tiene el editor', await js(`!!document.querySelector('.st-editor__input')`));
  ok('y el SQL de ejemplo resaltado', await js(`!!document.querySelector('.st-editor__hl .st-tk-kw')`));
  ok('sin grip nativo: el editor no es redimensionable por CSS', await js(`getComputedStyle(document.querySelector('.st-editor')).resize === 'none'`));
  await js(`(() => { const t = document.querySelector('.st-editor__input'); t.value = 'SELECT id, nombre FROM muestras WHERE id <= 30'; t.dispatchEvent(new Event('input')); })()`);
  await click('[data-role="run"]');
  await sleep(900);
  ok('corre la consulta', /30 filas/.test(await text('[data-role="qstatus"]')), await text('[data-role="qstatus"]'));
  ok('y el resultado va al grid', await js(`!!document.querySelector('.st-grid .st-row')`));
  await js(`(() => { const t = document.querySelector('.st-editor__input'); t.value = 'DELETE FROM muestras'; t.dispatchEvent(new Event('input')); })()`);
  await click('[data-role="run"]');
  await sleep(700);
  ok('un DELETE se rechaza con un mensaje claro', /solo lectura/.test(await text('.st-qerror')), await text('[data-role="qstatus"]'));
  const hl = await js(`(() => { const a = getComputedStyle(document.querySelector('.st-editor__hl')); const b = getComputedStyle(document.querySelector('.st-editor__input'));
    return ['fontFamily','fontSize','lineHeight','paddingTop','paddingLeft','letterSpacing'].every(k => a[k] === b[k]); })()`);
  ok('el resaltado y el textarea comparten métrica (alineados al píxel)', hl);

  console.log('\n9. Clicks de verdad (hit-testing)');
  /* Todo lo de arriba clickea con el.click(), que se saltea el hit-testing: si
     algo invisible tapa la ventana, esos clicks andan igual y el usuario no.
     Pasó: el velo de "soltá para abrir" quedó con pointer-events:auto por una
     regla de Opal y se comía todos los clicks. Acá se mira quién RECIBE el
     puntero y se clickea con eventos de mouse reales. */
  const tapados = await js(`(() => { const out = [];
    for (let x = 20; x < innerWidth; x += 120) for (let y = 10; y < innerHeight; y += 90) {
      const e = document.elementFromPoint(x, y);
      if (!e || e.closest('#op-layer')) out.push([x, y, e?.className || '(nada)']);
    } return out; })()`);
  ok('ningún overlay invisible tapa la ventana', tapados.length === 0, JSON.stringify(tapados.slice(0, 4)));
  const realClick = async (sel) => {
    const p = await js(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
      return r ? [Math.round(r.left + Math.min(30, r.width / 2)), Math.round(r.top + r.height / 2)] : null; })()`);
    if (!p) return false;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    return true;
  };
  await realClick('#rail-nav [data-obj="lotes"]');
  await sleep(900);
  ok('un click real en el rail navega', (await text('.op-viewhead__title')) === 'lotes', await text('.op-viewhead__title'));
  await realClick('#rail-db');
  await sleep(400);
  ok('un click real abre el menú de la base', await js(`[...document.querySelectorAll('.op-menuitem')].some(m => m.textContent.includes('Filas compactas'))`));
  key('Escape');
  await sleep(400);
  key('K', ['control']);
  await sleep(400);
  ok('no hay paleta de comandos', !(await js(`!!document.querySelector('.op-palette') || !!document.getElementById('btn-palette')`)));

  console.log('\n10. Cerrar');
  await js(`window.__strata.closeDatabase()`);
  await sleep(900);
  ok('vuelve al inicio', await js(`!!document.querySelector('.st-hero')`));
  ok('la base quedó en recientes', await js(`[...document.querySelectorAll('.st-recent')].some(r => r.dataset.openpath.endsWith('smoke.db'))`));
  const rail2 = await rect('.op-rail');
  ok('el rail se volvió a plegar', rail2 && rail2.w < 1, JSON.stringify(rail2));

  console.log('\n11. Consola limpia');
  const limpios = errores.filter((e) => !/gpu/i.test(e));
  ok('sin errores de renderer', limpios.length === 0, limpios.join(' | '));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  require(path.join(ROOT, 'src', 'db.cjs')).shutdown();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* queda, no pasa nada */ }
  app.exit(fail ? 1 : 0);
}).catch((e) => bail('arranque', e));
