/* ═══════════════════════════════════════════════════════════════════════════
   STRATA — resaltado de SQL
   Un tokenizador chico, no un parser: alcanza para que un CREATE TABLE largo
   se lea de un vistazo. Sigue la ley de Opal: el acento talla las palabras
   clave y nada más; el resto se distingue por luminancia, no por color.
   ═══════════════════════════════════════════════════════════════════════════ */

import { esc } from '../ui.js';

const KEYWORDS = new Set(`
  ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY
  CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE
  CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP
  EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM
  FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT
  INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING
  NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY
  RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK
  ROW ROWS SAVEPOINT SELECT SET STRICT STORED TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER
  UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT ROWID
`.trim().split(/\s+/));

const TYPES = new Set('INTEGER INT REAL TEXT BLOB NUMERIC BOOLEAN DATE DATETIME VARCHAR CHAR FLOAT DOUBLE BIGINT ANY'.split(' '));

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\bx'[0-9a-fA-F]*')|([A-Za-z_][A-Za-z0-9_$]*)|([^\s\w])/g;

/** SQL → HTML con spans st-tk-*. Todo el texto pasa por esc(). */
export function highlight(sql) {
  let out = '';
  let last = 0;
  const src = String(sql ?? '');
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    const [tok, com, str, ident, num, word, punct] = m;
    if (com) out += `<span class="st-tk-com">${esc(tok)}</span>`;
    else if (str) out += `<span class="st-tk-str">${esc(tok)}</span>`;
    else if (ident) out += `<span class="st-tk-id">${esc(tok)}</span>`;
    else if (num) out += `<span class="st-tk-num">${esc(tok)}</span>`;
    else if (word) {
      const up = word.toUpperCase();
      if (KEYWORDS.has(up)) out += `<span class="st-tk-kw">${esc(tok)}</span>`;
      else if (TYPES.has(up)) out += `<span class="st-tk-type">${esc(tok)}</span>`;
      else out += esc(tok);
    } else if (punct) out += `<span class="st-tk-p">${esc(tok)}</span>`;
    else out += esc(tok);
  }
  return out + esc(src.slice(last));
}

/** "tabla" citada para SQL, igual que en el main. */
export const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
