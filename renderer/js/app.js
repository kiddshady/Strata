/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — app
   Visor de bases SQLite, solo lectura. El renderer nunca toca la base: pide
   todo por IPC (window.strata) y la base vive en un proceso aparte
   (src/db-worker.cjs), que se puede matar para cancelar una consulta.

   Este archivo es el shell: arranque, rail, statusbar, comandos y atajos.
   Las vistas viven en js/strata/views/, una por archivo:
     inicio     sin base: abrir y recientes
     resumen    la base: tamaño, tablas, detalles del archivo
     tabla      datos (grid virtual + inspector) y estructura
     objeto     ficha de un índice o un trigger
     consulta   consola SQL de solo lectura
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Menu } from './overlays.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2, toggleReveal } from './motion.js';
import { esc, paint, head, attempt, colorToken } from './ui.js';
import { fmtBytes, fmtInt, fmtNum } from './format.js';

import { KIND_ICON } from './strata/icons.js';
import { S, api, on, emit, obj, ofKind, KIND, routeOf, show, saveSettings, copyValue } from './strata/state.js';
import { viewHome, forgetRecent, clearRecents, refreshRecents } from './strata/views/home.js';
import { viewOverview } from './strata/views/overview.js';
import { viewTable, current } from './strata/views/table.js';
import { viewObject } from './strata/views/object.js';
import { viewQuery, forgetResult } from './strata/views/query.js';

/* ══ La base ═════════════════════════════════════════════════════════════════ */

/** Abre una base: por ruta, o con el diálogo si no hay ruta. */
async function openDatabase(filePath) {
  const p = filePath || await attempt(() => api.db.pick(), { errorTitle: 'No se pudo abrir el diálogo' });
  if (!p) return null;
  document.body.classList.add('is-busy');
  try {
    return await attempt(async () => {
      const info = await api.db.open(p);
      S.db = info;
      S.objects = await api.db.schema();
      S.overview = null;
      S.counts = {};
      S.countsReady = false;
      forgetResult();
      emit('db');
      show('resumen');
      loadRecents();
      loadCounts();
      return info;
    }, { errorTitle: 'No se pudo abrir la base' });
  } finally {
    document.body.classList.remove('is-busy');
  }
}

async function closeDatabase() {
  if (!S.db) return;
  await attempt(() => api.db.close(), { errorTitle: 'No se pudo cerrar la base' });
  S.db = null;
  S.objects = [];
  S.counts = {};
  S.overview = null;
  forgetResult();
  emit('db');
  show('inicio');
  loadRecents();
}

/** Volver a leer la base del disco (otro programa la pudo haber cambiado). */
async function reloadDatabase() {
  if (!S.db) return;
  const at = [Router.name, Router.param];
  const p = S.db.path;
  const ok = await openDatabase(p);
  if (!ok) return;
  // Si el objeto sigue existiendo, quedarse donde se estaba.
  if (at[0] === 'tabla' || at[0] === 'objeto') { if (obj(at[1])) show(at[0], at[1]); }
  else if (at[0] === 'consulta') show('consulta');
  Toast.show({ title: 'Base recargada', text: S.db.name, icon: 'retry', duration: 2200 });
}

/** Filas por tabla: aparte, porque en una base grande el conteo tarda. */
async function loadCounts() {
  const path = S.db?.path;
  const names = S.objects.filter((o) => o.type === 'table').map((o) => o.name);
  try {
    const counts = await api.db.counts(names);
    if (S.db?.path !== path) return;
    S.counts = { ...counts, ...S.counts };
    S.countsReady = true;
    emit('counts');
  } catch (err) {
    if (err.message !== 'Cancelado') console.error('[conteos]', err);
  }
}

async function loadRecents() {
  try { S.recents = await api.recents.list(); } catch { S.recents = []; }
  emit('recents');
  refreshRecents();
}

/* ══ Rail: el árbol del esquema ══════════════════════════════════════════════ */

/** Conteo corto para el rail: 5k y no "5,0k" (el exacto va en el tooltip). */
const compact = (n) => fmtNum(n).replace(/[.,]0(?=[kM]$)/, '');

const GROUPS = ['table', 'view', 'virtual', 'index', 'trigger', 'internal'];
/** Grupos cerrados. Las internas arrancan cerradas: casi nunca son lo que se busca. */
const collapsed = new Set(['internal']);
let railFilter = '';

function railHTML() {
  const q = railFilter.toLowerCase();
  const nav = (view, icon, label, key) => `
    <button class="op-navitem" data-view="${view}" data-goto="${view}"${key ? ` data-tip="${label}" data-tip-key="${key}" data-tip-side="right"` : ''}>
      <i data-icon="${icon}"></i><span class="op-truncate">${label}</span></button>`;

  const groups = GROUPS.map((kind) => {
    const all = ofKind(kind);
    if (!all.length) return '';
    const items = q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all;
    if (q && !items.length) return '';
    const open = q || !collapsed.has(kind);
    return `
      <div class="op-rail__group st-group" data-group="${kind}">
        <button class="op-rail__group-label st-group__label${open ? ' is-open' : ''}" data-toggle-group="${kind}">
          <i data-icon="chevronRight" class="st-group__chev"></i>
          <span>${KIND[kind].many}</span>
          <span class="st-group__count op-num">${q ? `${items.length}/` : ''}${all.length}</span>
        </button>
        <div class="op-reveal${open ? ' is-open' : ''}"><div>
          ${items.map((o) => {
            const n = S.counts[o.name];
            return `<button class="op-navitem st-obj" data-obj="${esc(o.name)}">
              <i data-icon="${KIND_ICON[o.kind]}"></i>
              <span class="op-truncate">${esc(o.name)}</span>
              ${o.type === 'table' ? `<span class="op-navitem__count" data-count="${esc(o.name)}">${n == null ? '' : compact(n)}</span>` : ''}
            </button>`;
          }).join('')}
        </div></div>
      </div>`;
  }).join('');

  return `
    <div class="op-rail__group">
      ${nav('resumen', 'home', 'Resumen')}
      ${nav('consulta', 'terminal', 'Consulta SQL', 'Ctrl E')}
    </div>
    ${groups || (q ? '<div class="st-rail__none op-meta">Nada coincide</div>' : '')}`;
}

function paintRail() {
  const nav = document.getElementById('rail-nav');
  const dbBtn = document.getElementById('rail-db');
  if (!S.db) {
    nav.innerHTML = '';
    dbBtn.innerHTML = '';
    return;
  }
  dbBtn.innerHTML = `
    <span class="st-dbbtn__icon"><i data-icon="database"></i></span>
    <span class="st-dbbtn__text">
      <span class="st-dbbtn__name op-truncate">${esc(S.db.name)}</span>
      <span class="st-dbbtn__meta op-num">${fmtBytes(S.db.size + (S.db.wal || 0))} · ${fmtInt(S.objects.length)} objetos</span>
    </span>
    <i data-icon="chevronDown" class="st-dbbtn__chev"></i>`;
  dbBtn.dataset.tip = S.db.path;
  nav.innerHTML = railHTML();
  Icons.mount(dbBtn);
  Icons.mount(nav);
  markActive();
}

function markActive() {
  const name = Router.param;
  const isObj = Router.name === 'tabla' || Router.name === 'objeto';
  document.querySelectorAll('#rail-nav .st-obj').forEach((b) => b.classList.toggle('is-active', isObj && b.dataset.obj === name));
  document.querySelectorAll('#rail-nav .op-navitem[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === Router.name));
}

function updateCounts() {
  document.querySelectorAll('#rail-nav [data-count]').forEach((el) => {
    const n = S.counts[el.dataset.count];
    el.textContent = n == null ? '' : compact(n);
    if (n != null) el.dataset.tip = fmtInt(n);
  });
}

function dbMenu(anchor) {
  const others = S.recents.filter((r) => r.path !== S.db?.path && !r.missing).slice(0, 5);
  Menu.show(anchor, [
    { label: 'Abrir otra base…', icon: 'folder', key: 'Ctrl O', onSelect: () => openDatabase() },
    ...(others.length ? [{ groupLabel: 'Recientes' }, ...others.map((r) => ({ label: r.name, icon: 'database', onSelect: () => openDatabase(r.path) }))] : []),
    { sep: true },
    { label: 'Recargar', icon: 'retry', key: 'F5', onSelect: reloadDatabase },
    { label: 'Mostrar en el Explorador', icon: 'folder', onSelect: () => api.reveal(S.db.path) },
    { label: 'Copiar ruta', icon: 'copy', onSelect: () => copyValue(S.db.path) },
    { sep: true },
    { groupLabel: 'Preferencias' },
    { label: 'Filas compactas', icon: 'list', selected: S.settings.densidad === 'compacta',
      onSelect: () => { saveSettings({ densidad: S.settings.densidad === 'compacta' ? 'comoda' : 'compacta' }); Router.refresh(); } },
    { label: 'Reabrir la última base al arrancar', icon: 'retry', selected: !!S.settings.reabrir,
      onSelect: () => saveSettings({ reabrir: !S.settings.reabrir }, { now: true }) },
    ...(S.info?.dev ? [{ label: 'Piezas de Opal', icon: 'grid', onSelect: () => show('piezas') }] : []),
    { sep: true },
    { label: 'Cerrar base', icon: 'close', key: 'Ctrl W', onSelect: closeDatabase },
  ]);
}

/* ══ Chrome: statusbar, titlebar, modo sin base ══════════════════════════════ */

function updateChrome() {
  const has = !!S.db;
  // Sin base no hay nada que navegar: el rail se pliega y la vista ocupa todo.
  document.querySelector('.op-app').classList.toggle('st-bare', !has);
  document.title = has ? `${S.db.name} — Strata` : 'Strata';

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  document.querySelectorAll('[data-needs-db]').forEach((el) => el.classList.toggle('is-off', !has));
  set('stat-db', has ? S.db.name : 'Sin base abierta');
  if (has) {
    set('stat-size', fmtBytes(S.db.size + (S.db.wal || 0)));
    set('stat-enc', S.overview?.encoding ?? '—');
    set('stat-journal', String(S.overview?.journal ?? '—').toUpperCase());
    set('stat-sqlite', S.overview?.sqlite ? `SQLite ${S.overview.sqlite}` : 'SQLite');
  }
  const dbItem = document.getElementById('stat-db')?.parentElement;
  if (dbItem) dbItem.dataset.tip = has ? S.db.path : 'Abrí una base con Ctrl+O';

  const ctx = document.getElementById('titlebar-context');
  ctx.innerHTML = has ? `${Icons.svg('database', 'op-icon--sm')}<span>${esc(S.db.name)}</span>` : '';
}

/** El resumen trae encoding/journal/versión: para la statusbar se pide aparte. */
async function loadOverviewForChrome() {
  if (!S.db || S.overview) return updateChrome();
  const path = S.db.path;
  try {
    const ov = await api.db.overview();
    if (S.db?.path !== path) return;
    S.overview = S.overview || ov;
  } catch { /* la statusbar queda con guiones */ }
  updateChrome();
}

/* ══ Drag & drop ═════════════════════════════════════════════════════════════ */

function wireDrop() {
  const drop = document.createElement('div');
  drop.className = 'st-drop';
  drop.innerHTML = `<div class="st-drop__box">${Icons.svg('database', 'op-icon--xl')}<span>Soltá para abrir</span>
    <span class="op-meta">Se abre en solo lectura</span></div>`;
  document.getElementById('op-layer').appendChild(drop);

  // Solo reacciona a ARCHIVOS: arrastrar texto dentro de la app no es abrir nada.
  const isFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!isFile(e)) return;
    e.preventDefault();
    depth++;
    drop.classList.add('is-on');
  });
  window.addEventListener('dragover', (e) => { if (isFile(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', (e) => {
    if (!isFile(e)) return;
    if (--depth <= 0) { depth = 0; drop.classList.remove('is-on'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('is-on');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = api.pathForFile(file);
    if (p) openDatabase(p);
  });
}

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function wireShell() {
  const w = api.win;
  document.getElementById('win-min').addEventListener('click', () => w.minimize());
  document.getElementById('win-close').addEventListener('click', () => w.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn.addEventListener('click', () => w.toggleMaximize());
  w.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });
  // Doble click en la titlebar maximiza, como en cualquier ventana de Windows.
  document.querySelector('.op-titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button, .op-no-drag')) w.toggleMaximize();
  });

  document.getElementById('rail-db').addEventListener('click', (e) => dbMenu(e.currentTarget));

  const filter = document.getElementById('rail-filter');
  filter.addEventListener('input', () => {
    railFilter = filter.value.trim();
    document.getElementById('rail-nav').innerHTML = railHTML();
    Icons.mount(document.getElementById('rail-nav'));
    markActive();
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) { e.stopPropagation(); filter.value = ''; filter.dispatchEvent(new Event('input')); }
    if (e.key === 'Enter') document.querySelector('#rail-nav .st-obj')?.click();
  });

  /* Delegación global: las vistas se repintan enteras, así que enganchar los
     handlers en cada repintado sería recablear todo cada vez. */
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle-group]');
    if (toggle) {
      const kind = toggle.dataset.toggleGroup;
      const open = toggleReveal(toggle.nextElementSibling);
      toggle.classList.toggle('is-open', open);
      open ? collapsed.delete(kind) : collapsed.add(kind);
      return;
    }
    const forget = e.target.closest('[data-forget]');
    if (forget) { e.stopPropagation(); attempt(() => forgetRecent(forget.dataset.forget)); return; }

    const goto = e.target.closest('[data-goto]');
    if (goto) { show(goto.dataset.goto, goto.dataset.param || null); return; }

    const openp = e.target.closest('[data-openpath]');
    if (openp) { openDatabase(openp.dataset.openpath); return; }

    const o = e.target.closest('[data-obj]');
    if (o) { const target = obj(o.dataset.obj); if (target) show(...routeOf(target)); return; }

    const act = e.target.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'open') openDatabase();
      if (a === 'reload') reloadDatabase();
      if (a === 'reveal' && S.db) api.reveal(S.db.path);
      if (a === 'recents-clear') attempt(clearRecents);
    }
  });

  // Enter/Espacio sobre una reciente (son div role=button, no <button>).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest?.('[data-openpath][role="button"]');
    if (!row) return;
    e.preventDefault();
    openDatabase(row.dataset.openpath);
  });

  /* Atajos. Los de Electron (Ctrl+W cierra la ventana, Ctrl+R recarga) se
     sacaron del menú en main.cjs, así que estas teclas son nuestras. */
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && k === 'o') { e.preventDefault(); openDatabase(); return; }
    if (!S.db) return;
    if (ctrl && k === 'w') { e.preventDefault(); closeDatabase(); return; }
    if (e.key === 'F5') { e.preventDefault(); reloadDatabase(); return; }
    if (ctrl && k === 'e') { e.preventDefault(); show('consulta'); return; }
    if (ctrl && k === 'i') { e.preventDefault(); current.toggleInspector?.(); return; }
    if (ctrl && k === 'f') {
      e.preventDefault();
      // Ctrl+F filtra la vista; Ctrl+Shift+F (o una vista sin filtro) busca en el rail.
      if (current.focusFilter && !e.shiftKey) current.focusFilter();
      else { const f = document.getElementById('rail-filter'); f.focus(); f.select(); }
    }
  });

  on('db', () => { paintRail(); updateChrome(); loadOverviewForChrome(); });
  on('counts', updateCounts);
  Router.onChange(() => { markActive(); });
}

/* ══ Actualizaciones ═════════════════════════════════════════════════════════
   El main baja la versión nueva solo; acá se avisa en la statusbar, sin
   interrumpir. Click reinicia e instala; si no, se instala al cerrar. */
function wireUpdates() {
  const el = document.getElementById('stat-update');
  const paintUpdate = (s) => {
    if (!s || s.state === 'idle') { el.classList.remove('is-on'); return; }
    el.hidden = false;
    const ready = s.state === 'ready';
    el.innerHTML = ready
      ? `${Icons.svg('download')}<span>Strata ${esc(s.version)} lista · reiniciar</span>`
      : `${Icons.spinner()}<span class="op-num">Bajando ${esc(s.version)} · ${s.percent ?? 0}%</span>`;
    el.classList.toggle('is-ready', ready);
    el.dataset.tip = ready ? 'Cierra Strata, instala la versión nueva y la vuelve a abrir' : 'Se instala sola cuando termine';
    el.dataset.tipSide = 'top';
    requestAnimationFrame(() => el.classList.add('is-on'));
    if (ready && !el.dataset.announced) {
      el.dataset.announced = '1';
      Toast.show({ title: `Strata ${s.version} está lista`, text: 'Se instala al cerrar, o ahora desde la statusbar.', icon: 'download', duration: 7000 });
    }
  };
  el.addEventListener('click', () => { if (el.classList.contains('is-ready')) api.update.install(); });
  api.update.onState(paintUpdate);
  api.update.state().then(paintUpdate).catch(() => {});
}

/* ══ Color de la ventana ═════════════════════════════════════════════════════
   --op-bg está en oklch y Electron solo entiende hex. Se resuelve acá y se lo
   manda al proceso principal: el frame fantasma que pinta el compositor de
   Windows al restaurar sigue camuflado aunque cambies el matiz en tokens.css.
   La traducción la hace colorToken() con un canvas, no un regex (ver ui.js). */
function syncWindowColor() {
  const hex = colorToken('--op-bg');
  if (hex) api.win.setBackground(hex);
}

/* ══ Piezas (solo en --dev) ══════════════════════════════════════════════════
   La vitrina de Opal: todos los primitivos vivos. Sirve como referencia al
   tocar la interfaz; en la app normal no aparece. */
async function viewPiezas() {
  const { designHTML, wireDesign } = await import('./design-view.js');
  paint(head({ title: 'Piezas', sub: 'Los primitivos de Opal, vivos' }) + designHTML());
  wireDesign(document.getElementById('view'));
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  initClickFlash();
  initScrollFades();
  wireShell();
  wireDrop();
  wireUpdates();
  syncWindowColor();

  Router.define({
    inicio: { view: viewHome },
    resumen: { view: viewOverview },
    tabla: { view: viewTable },
    objeto: { view: viewObject },
    consulta: { view: viewQuery },
    piezas: { view: viewPiezas },
  }, document.getElementById('view'));

  try {
    S.info = await api.info();
    S.settings = await api.settings.get();
    S.recents = await api.recents.list();
  } catch (err) {
    paint(`<div class="st-error st-error--boot">${Icons.svg('alert')}<span>No se pudo iniciar: ${esc(err.message)}</span></div>`);
    console.error(err);
    return;
  }

  updateChrome();
  api.onOpenFile((p) => openDatabase(p));

  /* Qué abrir al arrancar: lo que vino por argv (doble click en un .db) gana;
     si no, la última base, si quedó abierta al cerrar y sigue existiendo. */
  let initial = null;
  try { initial = await api.pendingFile(); } catch { /* sin main de verdad (smoke) */ }
  const last = S.settings.reabrir && S.settings.ultimaBase;
  const lastOk = last && S.recents.some((r) => r.path === last && !r.missing);
  if (initial || lastOk) {
    const opened = await openDatabase(initial || last);
    if (!opened) show('inicio');
  } else {
    show('inicio');
  }

  // El splash se va recién cuando ya hay algo pintado debajo. El doble rAF
  // garantiza que el navegador aplicó los estilos de la vista antes del fade.
  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });
}

/* Hook de prueba: el smoke no puede usar el diálogo nativo, así que abre por
   ruta desde acá. Solo lo lee test/renderer.test.cjs. */
window.__strata = { openDatabase, closeDatabase, reloadDatabase, S };

boot();
