/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — Tabla (o vista): datos y estructura
   Dos pestañas sobre el mismo objeto. Datos es el grid virtual con filtro,
   orden e inspector de fila; Estructura es lo que la tabla ES: columnas,
   índices, claves foráneas, triggers y su CREATE.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../../icons.js';
import { Menu, Toast } from '../../overlays.js';
import { esc, paint, head, attempt } from '../../ui.js';
import { fmtInt, fmtBytes } from '../../format.js';
import { bindSwitcher, initScrollFades } from '../../motion.js';
import Router from '../../router.js';
import { S, api, obj, alive, KIND, hasRows, saveSettings, copyValue, countLabel } from '../state.js';
import { createGrid } from '../grid.js';
import { createInspector } from '../inspector.js';
import { copyText, jsonValue, displayText, isTruncated, kindOf } from '../cells.js';
import { highlight } from '../sql.js';
import { KIND_ICON } from '../icons.js';

/** Lo que la vista activa expone al shell (Ctrl+F, Ctrl+I, exportar). */
export const current = { focusFilter: null, toggleInspector: null, exportAs: null };

export async function viewTable(name) {
  const o = obj(name);
  if (!S.db || !hasRows(o)) return Router.go(S.db ? 'resumen' : 'inicio');
  const isAlive = alive();
  const kind = KIND[o.kind] || KIND.table;

  paint(head({
    title: o.name,
    sub: kind.one,
    crumbs: [{ label: S.db.name, view: 'resumen' }, { label: kind.many }],
    actions: `
      <button class="op-btn op-btn--ghost op-btn--sm" data-role="export" data-tip="Exportar lo que se ve, con filtro y orden"><i data-icon="download"></i> Exportar</button>`,
  }) + `
    <div class="op-tabs st-tabs" data-role="tabs">
      <button class="op-tab${S.tab === 'datos' ? ' is-active' : ''}" data-value="datos"><i data-icon="table"></i> Datos</button>
      <button class="op-tab${S.tab === 'estructura' ? ' is-active' : ''}" data-value="estructura"><i data-icon="layers"></i> Estructura</button>
    </div>
    <div class="st-tabbody op-bleed" data-role="tabbody"></div>`);

  const view = document.getElementById('view');
  const sub = view.querySelector('.op-viewhead__sub');
  const tabbody = view.querySelector('[data-role="tabbody"]');
  let teardown = null;

  const setSub = (rows) => {
    const parts = [kind.one];
    if (rows != null) parts.push(countLabel(rows, 'fila', 'filas'));
    if (o.ncol != null) parts.push(countLabel(o.ncol, 'columna'));
    if (o.withoutRowid) parts.push('WITHOUT ROWID');
    if (o.strict) parts.push('STRICT');
    sub.textContent = parts.join(' · ');
  };
  setSub(S.counts[o.name] ?? null);

  async function mount(tab) {
    teardown?.();
    teardown = null;
    tabbody.innerHTML = '';
    current.focusFilter = null;
    current.toggleInspector = null;
    current.exportAs = null;
    if (tab === 'datos') teardown = await mountData(o, tabbody, { isAlive, setSub });
    else await mountStructure(o, tabbody, { isAlive });
  }

  bindSwitcher(view.querySelector('[data-role="tabs"]'), (v) => { S.tab = v; mount(v); });
  view.querySelector('[data-role="export"]').addEventListener('click', (e) => {
    const exp = current.exportAs || ((fmt) => exportSource({ table: o.name }, fmt, o.name));
    Menu.show(e.currentTarget, [
      { label: 'CSV', icon: 'download', onSelect: () => exp('csv') },
      { label: 'JSON', icon: 'json', onSelect: () => exp('json') },
    ], { align: 'end' });
  });
  Router.onLeave(() => { teardown?.(); Object.keys(current).forEach((k) => { current[k] = null; }); });

  await mount(S.tab);
}

/* ══ Exportar ════════════════════════════════════════════════════════════════ */

export async function exportSource(source, format, name) {
  const r = await attempt(() => api.db.export({ source, format, name }), { errorTitle: 'No se pudo exportar' });
  if (!r) return;
  Toast.show({
    title: `Exportado: ${countLabel(r.rows, 'fila', 'filas')}`,
    text: `${fmtBytes(r.bytes)} · ${r.path}`,
    icon: 'download',
  });
}

/* ══ Datos ═══════════════════════════════════════════════════════════════════ */

async function mountData(o, host, { isAlive, setSub }) {
  host.innerHTML = `
    <div class="st-toolbar op-in-fade">
      <div class="op-inputwrap st-filter">
        <i data-icon="filter"></i>
        <input class="op-input" data-role="filter" placeholder="Filtrar en todas las columnas" spellcheck="false">
        <button class="op-iconbtn op-iconbtn--sm st-filter__clear" data-role="clear" data-tip="Limpiar filtro" tabindex="-1"><i data-icon="close"></i></button>
      </div>
      <div class="st-sortchip" data-role="sort"></div>
      <span class="op-spacer"></span>
      <span class="st-toolbar__meta op-num" data-role="status"></span>
      <button class="op-iconbtn op-flashable" data-role="insp" data-tip="Panel de fila" data-tip-key="Ctrl I"><i data-icon="panel"></i></button>
    </div>
    <div class="op-viewbody">
      <div class="op-viewbody__main"><div class="st-gridhost" data-role="grid"></div></div>
      <aside class="op-inspector st-insp${S.settings.inspector ? '' : ' is-collapsed'}" data-role="inspector"></aside>
    </div>`;
  Icons.mount(host);

  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  const filterEl = $('filter');
  const statusEl = $('status');
  const sortEl = $('sort');
  const inspBtn = $('insp');
  const wrap = filterEl.closest('.st-filter');

  let meta;
  try { meta = await api.db.meta(o.name); }
  catch (err) {
    $('grid').innerHTML = `<div class="st-error">${Icons.svg('alert')}<span>${esc(err.message)}</span></div>`;
    return null;
  }
  if (!isAlive()) return null;

  const q = { table: o.name, sort: null, filter: '', rowid: meta.hasRowid };
  let total = q.filter ? null : (S.counts[o.name] ?? null);
  let countSeq = 0;

  const inspector = createInspector($('inspector'), { table: meta.hasRowid ? o.name : null, columns: meta.columns });
  inspector.clear();
  inspBtn.classList.toggle('is-on', !!S.settings.inspector);

  const grid = createGrid($('grid'), {
    columns: meta.columns,
    total,
    rowHeight: S.settings.densidad === 'compacta' ? 24 : 28,
    emptyText: 'Sin filas',
    fetch: (offset, limit) => api.db.rows({ ...q, offset, limit }),
    sort: q.sort,
    onSort: (column, dir) => { q.sort = column ? { column, dir } : null; refresh(); },
    onCursor: (info) => { inspector.show(info); status(); },
    onActivate: () => { if (!S.settings.inspector) toggleInspector(); },
    onCopy: (info) => copyCell(info),
    onContext: (e, info) => contextMenu(e, info),
  });

  function status() {
    const cur = grid.cursor;
    const t = grid.total;
    if (t == null) { statusEl.innerHTML = `${Icons.spinner()} contando…`; return; }
    statusEl.textContent = cur ? `fila ${fmtInt(cur.r + 1)} de ${fmtInt(t)}` : countLabel(t, 'fila', 'filas');
  }

  function renderSort() {
    sortEl.innerHTML = q.sort
      ? `<button class="op-chip st-chipbtn" data-role="unsort" data-tip="Quitar el orden">
           ${Icons.svg(q.sort.dir === 'desc' ? 'sortDesc' : 'sortAsc')}<span class="op-mono">${esc(q.sort.column)}</span>${Icons.svg('close')}
         </button>`
      : '';
    sortEl.querySelector('[data-role="unsort"]')?.addEventListener('click', () => { q.sort = null; refresh(); });
  }

  async function loadCount() {
    const my = ++countSeq;
    status();
    try {
      const n = await api.db.count({ table: o.name, filter: q.filter });
      if (my !== countSeq || !isAlive()) return;
      grid.setTotal(n);
      if (!q.filter) { S.counts[o.name] = n; setSub(n); }
      status();
    } catch (err) {
      if (my === countSeq && err.message !== 'Cancelado') statusEl.textContent = err.message;
    }
  }

  function refresh() {
    const known = !q.filter && S.counts[o.name] != null ? S.counts[o.name] : null;
    grid.reset({ total: known, sort: q.sort });
    inspector.clear();
    renderSort();
    wrap.classList.toggle('has-value', !!q.filter);
    if (known == null) loadCount(); else status();
  }

  let filterTimer = null;
  filterEl.addEventListener('input', () => {
    clearTimeout(filterTimer);
    wrap.classList.toggle('has-value', !!filterEl.value);
    filterTimer = setTimeout(() => {
      if (q.filter === filterEl.value.trim()) return;
      q.filter = filterEl.value.trim();
      refresh();
    }, 260);
  });
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filterEl.value) { e.stopPropagation(); filterEl.value = ''; filterEl.dispatchEvent(new Event('input')); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); grid.focus(); if (!grid.cursor) grid.setCursor(0, 0); }
  });
  $('clear').addEventListener('click', () => { filterEl.value = ''; filterEl.dispatchEvent(new Event('input')); filterEl.focus(); });

  function toggleInspector() {
    const open = !S.settings.inspector;
    saveSettings({ inspector: open });
    $('inspector').classList.toggle('is-collapsed', !open);
    inspBtn.classList.toggle('is-on', open);
  }
  inspBtn.addEventListener('click', toggleInspector);

  async function copyCell(info) {
    if (!info.row) return;
    let v = inspector.fullValue(info.rowid, info.c) ?? info.row[info.c];
    // Un texto recortado se copia ENTERO: el portapapeles no es una vista previa.
    if (isTruncated(v) && info.rowid != null) {
      v = await attempt(() => api.db.cell({ table: o.name, rowid: info.rowid, column: info.column.name }),
        { errorTitle: 'No se pudo leer la celda' }) ?? v;
    }
    copyValue(copyText(v), `Copiado: ${info.column.name}`);
  }

  function rowJSON(info) {
    const out = {};
    meta.columns.forEach((c, i) => { out[c.name] = jsonValue(info.row[i]); });
    return JSON.stringify(out, null, 2);
  }

  function contextMenu(e, info) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY - 6}px;width:1px;height:1px`;
    document.body.appendChild(probe);
    const v = info.row?.[info.c];
    const col = info.column.name;
    const filterable = info.row && kindOf(v) !== 'blob' && kindOf(v) !== 'null';
    Menu.show(probe, [
      { label: 'Copiar valor', icon: 'copy', key: 'Ctrl C', disabled: !info.row, onSelect: () => copyCell(info) },
      { label: 'Copiar fila como JSON', icon: 'json', disabled: !info.row, onSelect: () => copyValue(rowJSON(info), 'Fila copiada como JSON') },
      { label: 'Copiar nombre de columna', icon: 'column', onSelect: () => copyValue(col) },
      { sep: true },
      { label: 'Filtrar por este valor', icon: 'filter', disabled: !filterable,
        onSelect: () => { filterEl.value = displayText(v); filterEl.dispatchEvent(new Event('input')); } },
      { label: `Ordenar por ${col}, ascendente`, icon: 'sortAsc', onSelect: () => { q.sort = { column: col, dir: 'asc' }; refresh(); } },
      { label: `Ordenar por ${col}, descendente`, icon: 'sortDesc', onSelect: () => { q.sort = { column: col, dir: 'desc' }; refresh(); } },
    ], { onClose: () => probe.remove() });
  }

  current.focusFilter = () => { filterEl.focus(); filterEl.select(); };
  current.toggleInspector = toggleInspector;
  current.exportAs = (fmt) => exportSource({ table: o.name, sort: q.sort, filter: q.filter }, fmt, o.name);

  renderSort();
  if (total == null) loadCount(); else status();
  initScrollFades(host);
  return () => grid.destroy();
}

/* ══ Estructura ══════════════════════════════════════════════════════════════ */

function chip(text, extra = '') {
  return `<span class="op-chip op-chip--mono ${extra}">${esc(text)}</span>`;
}

function link(name) {
  const target = obj(name);
  if (!target) return `<span class="op-mono">${esc(name)}</span>`;
  return `<button class="st-link op-mono" data-obj="${esc(name)}">${Icons.svg(KIND_ICON[target.kind], 'op-icon--sm')}${esc(name)}</button>`;
}

export function sqlCard(sql, { title = 'SQL', empty = 'Sin SQL: SQLite creó este objeto por su cuenta.' } = {}) {
  return `
    <section class="op-card op-in-rise">
      <div class="op-card__head">
        <span class="op-section__title">${title}</span>
        <span class="op-spacer"></span>
        ${sql ? `<button class="op-btn op-btn--ghost op-btn--sm" data-copy-sql><i data-icon="copy"></i> Copiar</button>` : ''}
      </div>
      <div class="op-card__body">
        ${sql ? `<pre class="st-code st-code--sql" data-sql>${highlight(sql)}</pre>` : `<div class="st-note">${empty}</div>`}
      </div>
    </section>`;
}

/** Cablea los botones de copiar SQL de una vista (se usa también en objeto.js). */
export function wireSqlCopy(root, sql) {
  root.querySelectorAll('[data-copy-sql]').forEach((b) => b.addEventListener('click', () => copyValue(sql, 'SQL copiado')));
}

async function mountStructure(o, host, { isAlive }) {
  host.innerHTML = '<div class="op-scroll op-grow st-pad st-structure"><div class="st-skel" style="--w:40%;height:14px"></div></div>';
  let st;
  try { st = await api.db.structure(o.name); }
  catch (err) {
    host.innerHTML = `<div class="st-error">${Icons.svg('alert')}<span>${esc(err.message)}</span></div>`;
    return;
  }
  if (!isAlive()) return;

  // Qué columnas son únicas por sí solas: un índice UNIQUE de una sola columna.
  const uniqueCols = new Set((st.indexes || []).filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0].name));
  const fkByCol = new Map((st.foreignKeys || []).map((f) => [f.from, f]));

  const columns = `
    <section class="op-card op-in-rise">
      <div class="op-card__head"><span class="op-section__title">Columnas</span><span class="op-meta op-num">${st.columns.length}</span></div>
      <div class="st-tablewrap">
        <table class="op-table st-coltable">
          <thead><tr><th class="op-td--tight">#</th><th>Nombre</th><th>Tipo</th><th>Restricciones</th><th>Default</th></tr></thead>
          <tbody>${st.columns.map((c) => {
            const fk = fkByCol.get(c.name);
            const tags = [
              c.pk ? chip(st.columns.filter((x) => x.pk).length > 1 ? `PK ${c.pk}` : 'PRIMARY KEY', 'st-chip--key') : '',
              c.notnull ? chip('NOT NULL') : '',
              uniqueCols.has(c.name) && !c.pk ? chip('UNIQUE') : '',
              c.hidden === 2 || c.hidden === 3 ? chip(c.hidden === 3 ? 'GENERATED STORED' : 'GENERATED') : '',
              c.hidden === 1 ? chip('HIDDEN') : '',
              fk ? `<span class="st-fk">${Icons.svg('arrowRight', 'op-icon--sm')}${link(fk.table)}<span class="op-mono op-dim">.${esc(fk.to ?? '')}</span></span>` : '',
            ].join('');
            return `<tr class="op-tr">
              <td class="op-td--tight op-td--num op-dim">${c.cid}</td>
              <td class="op-mono st-strong">${esc(c.name)}</td>
              <td class="op-mono">${c.type ? esc(c.type) : '<span class="op-dim">—</span>'}</td>
              <td><div class="st-tags">${tags || '<span class="op-dim">—</span>'}</div></td>
              <td class="op-mono">${c.dflt == null ? '<span class="op-dim">—</span>' : esc(c.dflt)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </section>`;

  // Los índices que creó SQLite por su cuenta, para una restricción de la tabla.
  const originLabel = { pk: 'automático · PK', u: 'automático', c: '' };
  const indexes = st.indexes?.length ? `
    <section class="op-card op-in-rise" style="--i:1">
      <div class="op-card__head"><span class="op-section__title">Índices</span><span class="op-meta op-num">${st.indexes.length}</span></div>
      <div class="op-card__body op-list">${st.indexes.map((ix) => `
        <div class="st-defrow">
          ${link(ix.name)}
          <span class="st-defrow__cols op-mono">(${ix.columns.map((c) => esc(c.name) + (c.desc ? ' DESC' : '')).join(', ')})</span>
          <span class="op-spacer"></span>
          ${ix.unique ? chip('UNIQUE') : ''}${originLabel[ix.origin] ? chip(originLabel[ix.origin], 'op-chip--outline') : ''}${ix.partial ? chip('PARCIAL', 'op-chip--outline') : ''}
        </div>`).join('')}
      </div>
    </section>` : '';

  const fks = st.foreignKeys?.length ? `
    <section class="op-card op-in-rise" style="--i:2">
      <div class="op-card__head"><span class="op-section__title">Claves foráneas</span><span class="op-meta op-num">${st.foreignKeys.length}</span></div>
      <div class="op-card__body op-list">${st.foreignKeys.map((f) => `
        <div class="st-defrow">
          <span class="op-mono st-strong">${esc(f.from)}</span>
          ${Icons.svg('arrowRight', 'op-icon--sm op-dim')}
          ${link(f.table)}<span class="op-mono op-dim">.${esc(f.to ?? '')}</span>
          <span class="op-spacer"></span>
          ${f.onDelete && f.onDelete !== 'NO ACTION' ? chip(`ON DELETE ${f.onDelete}`, 'op-chip--outline') : ''}
          ${f.onUpdate && f.onUpdate !== 'NO ACTION' ? chip(`ON UPDATE ${f.onUpdate}`, 'op-chip--outline') : ''}
        </div>`).join('')}
      </div>
    </section>` : '';

  const triggers = st.triggers?.length ? `
    <section class="op-card op-in-rise" style="--i:3">
      <div class="op-card__head"><span class="op-section__title">Triggers</span><span class="op-meta op-num">${st.triggers.length}</span></div>
      <div class="op-card__body op-list">${st.triggers.map((t) => `<div class="st-defrow">${link(t)}</div>`).join('')}</div>
    </section>` : '';

  host.innerHTML = `
    <div class="op-scroll op-grow st-pad st-structure">
      ${columns}${indexes}${fks}${triggers}${sqlCard(st.sql)}
    </div>`;
  Icons.mount(host);
  initScrollFades(host);
  wireSqlCopy(host, st.sql);
}
