/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — Consola SQL
   Para lo que el grid no alcanza: un JOIN, un GROUP BY, un PRAGMA. Solo
   lectura por diseño: el worker rechaza toda sentencia que SQLite no declare
   lectora ANTES de correrla (ver db-worker.cjs → query).

   El editor es un <textarea> con un <pre> resaltado debajo, alineados al
   píxel: el textarea tiene el texto transparente y el cursor visible, así
   que se escribe en un campo nativo (con deshacer, selección, IME) y se ve
   el SQL coloreado. Los dos tienen que compartir fuente, padding y scroll.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../../icons.js';
import { Menu } from '../../overlays.js';
import { esc, paint, head } from '../../ui.js';
import { fmtInt, fmtDur } from '../../format.js';
import Router from '../../router.js';
import { S, api, alive, ofKind, saveSettings, copyValue, countLabel } from '../state.js';
import { createGrid } from '../grid.js';
import { createInspector } from '../inspector.js';
import { copyText } from '../cells.js';
import { highlight, quoteIdent } from '../sql.js';
import { exportSource, current } from './table.js';

let last = null;   // el último resultado, para volver a la vista sin re-ejecutar
let editorHeight = 0;

function defaultSql() {
  const t = ofKind('table')[0] || ofKind('view')[0];
  return t ? `SELECT *\nFROM ${quoteIdent(t.name)}\nLIMIT 100;` : 'SELECT sqlite_version();';
}

export function viewQuery() {
  if (!S.db) return Router.go('inicio');
  const isAlive = alive();

  paint(head({
    title: 'Consulta',
    sub: 'Solo lectura: SELECT, WITH, EXPLAIN y los PRAGMA que leen',
    crumbs: [{ label: S.db.name, view: 'resumen' }, { label: 'SQL' }],
    actions: `
      <button class="op-btn op-btn--ghost op-btn--sm" data-role="export" disabled data-tip="Exportar el resultado completo"><i data-icon="download"></i> Exportar</button>
      <button class="op-btn op-btn--primary op-flashable" data-role="run"><i data-icon="play"></i> <span>Ejecutar</span> <span class="op-kbd">Ctrl <i data-icon="keyEnter"></i></span></button>`,
  }) + `
    <div class="st-editorwrap">
      <div class="st-editor op-in-fade">
        <pre class="st-editor__hl" aria-hidden="true"></pre>
        <textarea class="st-editor__input" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"
          aria-label="Consulta SQL"></textarea>
      </div>
      <div class="st-editor__grip" data-role="grip" data-tip="Arrastrá para cambiar el alto"></div>
    </div>
    <div class="st-toolbar st-qstatus" data-role="qstatus"></div>
    <div class="op-viewbody">
      <div class="op-viewbody__main"><div class="st-gridhost" data-role="grid"></div></div>
      <aside class="op-inspector st-insp${S.settings.inspector ? '' : ' is-collapsed'}" data-role="inspector"></aside>
    </div>`);

  const view = document.getElementById('view');
  const $ = (r) => view.querySelector(`[data-role="${r}"]`);
  const ta = view.querySelector('.st-editor__input');
  const hl = view.querySelector('.st-editor__hl');
  const runBtn = $('run');
  const expBtn = $('export');
  const statusEl = $('qstatus');
  let grid = null;
  let inspector = null;
  let running = false;

  ta.value = S.settings.consulta || defaultSql();
  const paintHl = () => { hl.innerHTML = `${highlight(ta.value)}\n`; };
  const syncScroll = () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; };
  paintHl();

  // El alto del editor se arrastra y se recuerda en la sesión.
  const editor = view.querySelector('.st-editor');
  if (editorHeight) editor.style.height = `${editorHeight}px`;
  const grip = $('grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = editor.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-dragging');
    const move = (ev) => {
      editorHeight = Math.max(84, Math.min(window.innerHeight * 0.6, h0 + ev.clientY - y0));
      editor.style.height = `${editorHeight}px`;
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('lostpointercapture', () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('is-dragging');
    }, { once: true });
  });

  ta.addEventListener('input', () => { paintHl(); syncScroll(); saveSettings({ consulta: ta.value }); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); return; }
    // Tab indenta en vez de salir del campo: en un editor es lo que se espera.
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });

  function statusHTML(res) {
    if (!res) return '<span class="op-meta">Ctrl+Enter ejecuta. Si hay texto seleccionado, corre solo eso.</span>';
    if (res.error) return `<span class="st-qerror">${Icons.svg('alert')}<span class="op-copyable">${esc(res.error)}</span></span>`;
    return `<span class="st-qok">${Icons.svg('check')}<span class="op-num">${countLabel(res.total, 'fila', 'filas')}</span></span>
      <span class="op-meta op-num">${fmtDur(res.ms)}</span>
      ${res.truncated ? `<span class="op-chip op-chip--outline">mostrando las primeras ${fmtInt(res.cap)}</span>` : ''}
      <span class="op-spacer"></span>
      <button class="op-iconbtn op-flashable" data-role="insp" data-tip="Panel de fila" data-tip-key="Ctrl I"><i data-icon="panel"></i></button>`;
  }

  function toggleInspector() {
    const open = !S.settings.inspector;
    saveSettings({ inspector: open });
    $('inspector').classList.toggle('is-collapsed', !open);
    $('insp')?.classList.toggle('is-on', open);
  }

  function showResult(res) {
    statusEl.innerHTML = statusHTML(res);
    Icons.mount(statusEl);
    $('insp')?.addEventListener('click', toggleInspector);
    $('insp')?.classList.toggle('is-on', !!S.settings.inspector);
    grid?.destroy();
    grid = null;
    expBtn.disabled = !res || !!res.error;
    if (!res || res.error) {
      $('grid').innerHTML = res?.error ? '' : `<div class="st-note st-note--center">${Icons.svg('terminal')}<span>El resultado aparece acá</span></div>`;
      $('inspector').innerHTML = '';
      Icons.mount($('grid'));
      return;
    }
    inspector = createInspector($('inspector'), { table: null, columns: res.columns });
    inspector.clear();
    const firstPage = res.rows;
    grid = createGrid($('grid'), {
      columns: res.columns,
      total: res.total,
      rowHeight: S.settings.densidad === 'compacta' ? 24 : 28,
      emptyText: 'La consulta no devolvió filas',
      fetch: (offset, limit) => (offset + limit <= firstPage.length
        ? Promise.resolve({ rows: firstPage.slice(offset, offset + limit) })
        : api.db.queryPage({ id: res.id, offset, limit })),
      onCursor: (info) => inspector.show(info),
      onActivate: () => { if (!S.settings.inspector) toggleInspector(); },
      onCopy: (info) => info.row && copyValue(copyText(info.row[info.c]), `Copiado: ${info.column.name}`),
      onContext: (e, info) => {
        const probe = document.createElement('div');
        probe.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY - 6}px;width:1px;height:1px`;
        document.body.appendChild(probe);
        Menu.show(probe, [
          { label: 'Copiar valor', icon: 'copy', key: 'Ctrl C', disabled: !info.row, onSelect: () => copyValue(copyText(info.row[info.c])) },
          { label: 'Copiar nombre de columna', icon: 'column', onSelect: () => copyValue(info.column.name) },
        ], { onClose: () => probe.remove() });
      },
    });
  }

  let cancelTimer = null;
  async function run() {
    if (running) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const sql = sel.trim() ? sel : ta.value;
    running = true;
    view.classList.add('is-running');
    runBtn.querySelector('span').textContent = 'Ejecutando';
    statusEl.innerHTML = `<span class="op-meta">${Icons.spinner()} Ejecutando…</span>`;
    // El botón de cancelar aparece solo si la consulta tarda: en las rápidas
    // sería un parpadeo sin sentido.
    cancelTimer = setTimeout(() => {
      statusEl.insertAdjacentHTML('beforeend', `<button class="op-btn op-btn--secondary op-btn--sm op-in-fade" data-role="cancel"><i data-icon="stop"></i> Cancelar</button>`);
      Icons.mount(statusEl);
      $('cancel')?.addEventListener('click', () => api.db.cancel().catch(() => {}));
    }, 400);

    let res;
    try { res = await api.db.query(sql); }
    catch (err) { res = { error: err.message === 'Cancelado' ? 'Consulta cancelada.' : err.message }; }
    clearTimeout(cancelTimer);
    running = false;
    if (!isAlive()) { last = res; return; }
    view.classList.remove('is-running');
    runBtn.querySelector('span').textContent = 'Ejecutar';
    last = res;
    showResult(res);
  }

  runBtn.addEventListener('click', run);
  expBtn.addEventListener('click', (e) => {
    if (!last?.id) return;
    Menu.show(e.currentTarget, [
      { label: 'CSV', icon: 'download', onSelect: () => exportSource({ resultId: last.id }, 'csv', 'consulta') },
      { label: 'JSON', icon: 'json', onSelect: () => exportSource({ resultId: last.id }, 'json', 'consulta') },
    ], { align: 'end' });
  });

  current.toggleInspector = toggleInspector;
  current.focusFilter = () => ta.focus();
  Router.onLeave(() => { grid?.destroy(); current.toggleInspector = null; current.focusFilter = null; });

  // Volver a la consola muestra el último resultado sin volver a correrlo.
  showResult(last && !last.error ? last : null);
  ta.focus();
}

/** Otra base abierta: el resultado viejo era de la otra. */
export function forgetResult() { last = null; }
