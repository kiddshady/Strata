/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — Resumen de la base
   Lo primero que se ve al abrir: qué pesa, qué tiene y cómo está guardada.
   Las filas por tabla llegan después (en una base grande el conteo tarda),
   así que la vista se pinta enseguida y los números entran cuando llegan.
   ═══════════════════════════════════════════════════════════════════════════ */

import { esc, paint, head } from '../../ui.js';
import { fmtBytes, fmtInt, fmtDate } from '../../format.js';
import { countTo, stagger } from '../../motion.js';
import Router from '../../router.js';
import { S, api, on, alive, ofKind, KIND } from '../state.js';
import { KIND_ICON } from '../icons.js';

const tables = () => [...ofKind('table'), ...ofKind('virtual')];

function stat(label, value, id, unit = '') {
  return `<div class="op-stat">
    <span class="op-stat__label">${label}</span>
    <span class="op-stat__value" ${id ? `id="${id}"` : ''}>${value}${unit ? ` <span class="op-stat__unit">${unit}</span>` : ''}</span>
  </div>`;
}

function totalRows() {
  if (!S.countsReady) return null;
  return tables().reduce((a, t) => a + (S.counts[t.name] ?? 0), 0);
}

function tablesHTML() {
  const list = tables();
  if (!list.length) {
    return '<div class="st-note">Esta base no tiene tablas.</div>';
  }
  const max = Math.max(1, ...list.map((t) => S.counts[t.name] ?? 0));
  return list.map((t) => {
    const n = S.counts[t.name];
    const pct = n == null ? 0 : Math.max(n ? 1.5 : 0, (n / max) * 100);
    return `
      <button class="op-listitem op-in-rise st-tablerow" data-obj="${esc(t.name)}">
        <i data-icon="${KIND_ICON[t.kind]}"></i>
        <span class="op-listitem__main">
          <span class="op-listitem__title">${esc(t.name)}</span>
          <span class="op-meter st-tablerow__meter"><span class="op-meter__fill" style="--op-pct:${pct}%"></span></span>
        </span>
        <span class="op-listitem__aside">
          ${t.ncol != null ? `<span class="op-meta op-num">${t.ncol} col</span>` : ''}
          <span class="st-tablerow__rows op-num" data-count="${esc(t.name)}">${n == null ? (S.countsReady ? '—' : '<span class="st-skel" style="--w:40px"></span>') : fmtInt(n)}</span>
        </span>
      </button>`;
  }).join('');
}

function kv(k, v, { mono = false, tip = '' } = {}) {
  return `<span class="op-kv__k">${k}</span><span class="op-kv__v${mono ? ' op-mono' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${v}</span>`;
}

function detailsHTML(ov) {
  if (!ov) return '<div class="st-skel" style="--w:70%;height:12px"></div>';
  const f = ov.file;
  return `<div class="op-kv st-kv">
    ${kv('Archivo', esc(f.path), { mono: true, tip: f.path })}
    ${kv('Modificado', esc(fmtDate(f.mtime, { withTime: true })))}
    ${kv('SQLite', esc(ov.sqlite), { mono: true })}
    ${kv('Codificación', esc(ov.encoding ?? '—'), { mono: true })}
    ${kv('Journal', esc(String(ov.journal ?? '—').toUpperCase()), { mono: true })}
    ${kv('Página', `${fmtInt(ov.pageSize)} B × ${fmtInt(ov.pageCount)}`, { mono: true })}
    ${kv('Libres', `${fmtInt(ov.freePages)} páginas${ov.freePages ? ` · ${fmtBytes(ov.freePages * ov.pageSize)}` : ''}`, { mono: true })}
    ${kv('Auto-vacuum', esc(ov.autoVacuum ?? '—'), { mono: true })}
    ${kv('user_version', esc(String(ov.userVersion ?? '—')), { mono: true })}
    ${kv('application_id', esc(String(ov.applicationId ?? '—')), { mono: true })}
  </div>`;
}

export async function viewOverview() {
  if (!S.db) return Router.go('inicio');
  const isAlive = alive();
  const size = S.db.size + (S.db.wal || 0);
  const n = (k) => ofKind(k).length;

  paint(head({
    title: S.db.name,
    sub: 'Resumen de la base',
    actions: `
      <button class="op-btn op-btn--ghost op-btn--sm" data-action="reveal" data-tip="Mostrar en el Explorador"><i data-icon="folder"></i> Carpeta</button>
      <button class="op-btn op-btn--ghost op-btn--sm" data-action="reload" data-tip="Volver a leer la base" data-tip-key="F5"><i data-icon="retry"></i> Recargar</button>`,
  }) + `
    <div class="op-scroll op-grow st-overview">
      <div class="op-card st-stats op-in-rise">
        ${stat('Tamaño', fmtBytes(size), '', S.db.wal ? `+ WAL ${fmtBytes(S.db.wal)}` : '')}
        ${stat('Tablas', fmtInt(tables().length))}
        ${stat('Filas', totalRows() == null ? '<span class="st-skel" style="--w:64px;height:18px"></span>' : fmtInt(totalRows()), 'ov-rows')}
        ${stat('Vistas', fmtInt(n('view')))}
        ${stat('Índices', fmtInt(n('index')))}
        ${stat('Triggers', fmtInt(n('trigger')))}
      </div>
      <div class="st-overview__cols">
        <section class="op-card op-in-rise" style="--i:2">
          <div class="op-card__head"><span class="op-section__title">${KIND.table.many}</span></div>
          <div class="op-card__body op-list st-tablelist" id="ov-tables">${tablesHTML()}</div>
        </section>
        <section class="op-card op-in-rise" style="--i:3">
          <div class="op-card__head"><span class="op-section__title">Detalles</span></div>
          <div class="op-card__body" id="ov-details">${detailsHTML(S.overview)}</div>
        </section>
      </div>
    </div>`);
  stagger(document.getElementById('ov-tables'));

  const offCounts = on('counts', () => {
    if (!isAlive()) return;
    const rowsEl = document.getElementById('ov-rows');
    const total = totalRows();
    if (rowsEl && total != null) countTo(rowsEl, total, { format: fmtInt, duration: 600 });
    const list = document.getElementById('ov-tables');
    if (list) {
      // Solo los números y los medidores: repintar la lista reiniciaría su entrada.
      const max = Math.max(1, ...tables().map((t) => S.counts[t.name] ?? 0));
      list.querySelectorAll('[data-count]').forEach((el) => {
        const c = S.counts[el.dataset.count];
        el.textContent = c == null ? '—' : fmtInt(c);
        const fill = el.closest('.st-tablerow')?.querySelector('.op-meter__fill');
        if (fill) fill.style.setProperty('--op-pct', `${c == null ? 0 : Math.max(c ? 1.5 : 0, (c / max) * 100)}%`);
      });
    }
  });
  Router.onLeave(offCounts);

  if (!S.overview) {
    try { S.overview = await api.db.overview(); } catch (err) { console.error(err); }
    if (!isAlive()) return;
    const d = document.getElementById('ov-details');
    if (d) { d.innerHTML = detailsHTML(S.overview); d.classList.add('op-in-fade'); }
  }
}
