/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — íconos del dominio
   Se suman al set de Opal con Icons.add() (nunca editando icons.js), con la
   misma receta: grilla de 16, trazo 1.5, contenido entre 1.8 y 14.2.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from '../icons.js';

/* La marca: una muestra de roca cortada, con sus estratos. El bloque es la
   piedra (trazo pleno) y las dos vetas son la luz de adentro (apagadas, con
   la misma clase que el fuego del cabujón de Opal). Tiene que coincidir con
   el splash del index.html, que la dibuja antes de que exista este módulo. */
export const BRAND = '<rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2.6"/>'
  + '<path class="op-brand__trail" d="M2.3 6.4c1.9-.9 3.8-.9 5.7 0s3.8.9 5.7 0"/>'
  + '<path class="op-brand__trail" d="M2.3 9.9c1.9.9 3.8.9 5.7 0s3.8-.9 5.7 0"/>';

Icons.add({
  strata: BRAND,

  database: '<ellipse cx="8" cy="3.9" rx="5.4" ry="1.9"/>'
    + '<path d="M2.6 3.9v8.2c0 1.05 2.42 1.9 5.4 1.9s5.4-.85 5.4-1.9V3.9"/>'
    + '<path d="M2.6 8c0 1.05 2.42 1.9 5.4 1.9s5.4-.85 5.4-1.9"/>',

  table: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.8"/><path d="M2 6.2h12M6.6 6.2v7.2"/>',
  view: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.8" stroke-dasharray="2.4 1.6"/><path d="M2 6.2h12"/>',
  virtual: '<path d="M4.4 13.4H3.8A1.8 1.8 0 0 1 2 11.6V4.4a1.8 1.8 0 0 1 1.8-1.8h8.4A1.8 1.8 0 0 1 14 4.4v2"/><path d="M2 6.2h7.4"/><circle cx="11.2" cy="11" r="2.2"/><path d="M12.8 12.6 14.2 14"/>',
  index: '<path d="M2.6 3.4h10.8M2.6 6.6h7.6M2.6 9.8h4.8M2.6 13h2.2"/>',
  trigger: '<path d="M9 1.9 3.6 9h4.2l-.8 5.1L12.4 7H8.2z"/>',
  internal: '<rect x="3.4" y="7.2" width="9.2" height="6.6" rx="1.6"/><path d="M5.4 7.2V5.4a2.6 2.6 0 0 1 5.2 0v1.8"/>',
  column: '<rect x="5" y="2" width="6" height="12" rx="1.6"/><path d="M5 6h6M5 10h6"/>',

  json: '<path d="M5.8 2.6H5.2a1.6 1.6 0 0 0-1.6 1.6v1.8c0 .8-.6 1.5-1.4 2 .8.5 1.4 1.2 1.4 2v1.8a1.6 1.6 0 0 0 1.6 1.6h.6"/>'
    + '<path d="M10.2 2.6h.6a1.6 1.6 0 0 1 1.6 1.6v1.8c0 .8.6 1.5 1.4 2-.8.5-1.4 1.2-1.4 2v1.8a1.6 1.6 0 0 1-1.6 1.6h-.6"/>',
  image: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.8"/><circle cx="5.6" cy="6.2" r="1.1"/><path d="m2.4 12 3.6-3.4 2.6 2.4 2-1.8 3 2.6"/>',
  binary: '<rect x="2.2" y="2.6" width="4.4" height="4.4" rx="1.2"/><rect x="9.4" y="9" width="4.4" height="4.4" rx="1.2"/><path d="M9.4 3v3.6M11.6 2.6v4.4M4.4 9v4.4"/>',

  sortAsc: '<path d="M8 13.2V3M4.4 6.6 8 3l3.6 3.6"/>',
  sortDesc: '<path d="M8 2.8V13M4.4 9.4 8 13l3.6-3.6"/>',
});

/** Ícono por tipo de objeto del esquema. */
export const KIND_ICON = {
  table: 'table',
  view: 'view',
  virtual: 'virtual',
  internal: 'internal',
  index: 'index',
  trigger: 'trigger',
};
