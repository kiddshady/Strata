/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — Inicio (sin base abierta)
   La puerta: abrir una base y, abajo, las recientes. Sin rail — no hay nada
   que navegar todavía — así que la vista ocupa la ventana entera.
   ═══════════════════════════════════════════════════════════════════════════ */

import { esc, paint } from '../../ui.js';
import { fmtBytes, relTime, ellipsize } from '../../format.js';
import { Icons } from '../../icons.js';
import { stagger, exit } from '../../motion.js';
import { S, api, emit } from '../state.js';
import { BRAND } from '../icons.js';

function recentsHTML() {
  if (!S.recents.length) return '';
  return `
    <section class="st-home__recents op-in-rise">
      <div class="st-home__label">
        <span class="op-eyebrow">Recientes</span>
        <button class="op-btn op-btn--ghost op-btn--sm" data-action="recents-clear">Limpiar</button>
      </div>
      <div class="op-list" id="home-recents">
        ${S.recents.map((r) => `
          <div class="op-listitem op-in-rise st-recent${r.missing ? ' is-missing' : ''}" role="button" tabindex="0"
               data-openpath="${esc(r.path)}">
            <span class="st-recent__icon"><i data-icon="${r.missing ? 'alert' : 'database'}"></i></span>
            <span class="op-listitem__main">
              <span class="op-listitem__title">${esc(r.name)}</span>
              <span class="op-listitem__sub op-mono" data-tip="${esc(r.path)}">${esc(ellipsize(r.path, 72))}</span>
            </span>
            <span class="op-listitem__aside">
              <span class="op-meta op-num">${r.missing ? 'no está' : fmtBytes(r.size)}</span>
              <span class="op-meta">${relTime(r.openedAt)}</span>
              <span class="op-rowactions">
                <button class="op-iconbtn op-iconbtn--sm" data-forget="${esc(r.path)}" data-tip="Quitar de recientes"><i data-icon="close"></i></button>
              </span>
            </span>
          </div>`).join('')}
      </div>
    </section>`;
}

export function viewHome() {
  paint(`
    <div class="op-scroll op-grow st-home">
      <div class="st-home__inner">
        <div class="st-hero op-in-rise">
          <svg class="st-hero__mark" viewBox="0 0 16 16" aria-hidden="true">${BRAND}</svg>
          <h1 class="st-hero__title">Strata</h1>
          <p class="st-hero__text">Mirá adentro de cualquier base SQLite. Todo se abre en solo lectura: acá no se rompe nada.</p>
          <div class="st-hero__actions">
            <button class="op-btn op-btn--primary op-btn--lg op-flashable" data-action="open">
              <i data-icon="folder"></i> Abrir base… <span class="op-kbd">Ctrl O</span>
            </button>
          </div>
          <span class="op-meta">o soltá el archivo en la ventana</span>
        </div>
        <div id="home-recents-slot">${recentsHTML()}</div>
      </div>
    </div>`);
  const list = document.getElementById('home-recents');
  if (list) stagger(list);
}

/** Quitar una reciente: la fila se va animada, y si era la última, la sección. */
export async function forgetRecent(path) {
  const row = [...document.querySelectorAll('#home-recents [data-openpath]')].find((el) => el.dataset.openpath === path);
  S.recents = await api.recents.remove(path);
  emit('recents');
  const section = document.querySelector('.st-home__recents');
  if (!S.recents.length && section) return exit(section, { fallback: 300 });
  if (row) exit(row, { fallback: 300 });
}

export async function clearRecents() {
  S.recents = await api.recents.clear();
  emit('recents');
  const section = document.querySelector('.st-home__recents');
  if (section) exit(section, { fallback: 300 });
}

/** Repinta la lista si llegó algo nuevo (p. ej. se abrió una base desde afuera). */
export function refreshRecents() {
  const slot = document.getElementById('home-recents-slot');
  if (!slot) return;
  slot.innerHTML = recentsHTML();
  Icons.mount(slot);
}
