/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — Ficha de un índice o un trigger
   No tienen filas que mostrar: lo que importa es a qué tabla pertenecen,
   sobre qué columnas trabajan y su CREATE.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../../icons.js';
import { esc, paint, head } from '../../ui.js';
import { initScrollFades } from '../../motion.js';
import Router from '../../router.js';
import { S, api, obj, alive, KIND } from '../state.js';
import { KIND_ICON } from '../icons.js';
import { sqlCard, wireSqlCopy } from './table.js';

const ORIGIN = {
  pk: 'lo creó SQLite para la PRIMARY KEY',
  u: 'lo creó SQLite para una restricción UNIQUE',
  c: 'creado con CREATE INDEX',
};

export async function viewObject(name) {
  const o = obj(name);
  if (!S.db || !o) return Router.go(S.db ? 'resumen' : 'inicio');
  const isAlive = alive();
  const kind = KIND[o.kind];

  paint(head({
    title: o.name,
    sub: kind.one,
    crumbs: [{ label: S.db.name, view: 'resumen' }, { label: kind.many }],
  }) + '<div class="op-scroll op-grow st-structure" id="obj-body"></div>');

  let st;
  try { st = await api.db.structure(name); } catch (err) { st = { error: err.message }; }
  if (!isAlive()) return;

  const parent = obj(o.table);
  const rows = [
    ['Tabla', parent
      ? `<button class="st-link op-mono" data-obj="${esc(parent.name)}">${Icons.svg(KIND_ICON[parent.kind], 'op-icon--sm')}${esc(parent.name)}</button>`
      : `<span class="op-mono">${esc(o.table)}</span>`],
  ];
  if (o.type === 'index' && !st.error) {
    rows.push(['Columnas', `<span class="op-mono">${st.columns.map((c) => esc(c.name) + (c.desc ? ' DESC' : '')).join(', ')}</span>`]);
    rows.push(['Único', st.unique ? 'Sí' : 'No']);
    rows.push(['Origen', ORIGIN[st.origin] || '—']);
    if (st.partial) rows.push(['Parcial', 'Sí: tiene WHERE']);
  }
  if (o.type === 'trigger') {
    const m = /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)\b/i.exec(o.sql || '');
    if (m) rows.push(['Cuándo', `<span class="op-mono">${esc(`${m[1]} ${m[2]}`.toUpperCase().replace(/\s+/g, ' '))}</span>`]);
  }

  const body = document.getElementById('obj-body');
  body.innerHTML = `
    <section class="op-card op-in-rise">
      <div class="op-card__body op-kv st-kv">
        ${rows.map(([k, v]) => `<span class="op-kv__k">${k}</span><span class="op-kv__v">${v}</span>`).join('')}
      </div>
    </section>
    ${st.error ? `<div class="st-error">${Icons.svg('alert')}<span>${esc(st.error)}</span></div>` : ''}
    ${sqlCard(o.sql, { empty: 'Sin SQL: es un índice automático, SQLite lo creó por su cuenta para una restricción de la tabla.' })}`;
  Icons.mount(body);
  initScrollFades(body.parentElement);
  wireSqlCopy(body, o.sql);
}
