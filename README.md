# Strata

Visor de bases SQLite para escritorio. **Solo lectura**: abre cualquier `.db`
sin poder cambiarle un byte. Hecho sobre [Opal](S:\tools\Opal).

```
npm start               # abrir la app
npm run dev             # con la consola del renderer en la terminal y Piezas en el menú de la base
npm start -- base.db    # abrir una base directo
npm run check           # todo: unitarios + capa de datos + humo de la interfaz
```

## Qué hace

- **Resumen** de la base: tamaño (con el WAL), tablas y filas, encoding,
  journal, páginas, `user_version`…
- **Grid virtual**: da lo mismo que la tabla tenga 40 filas o 40 millones.
  Ordenar con click en el encabezado, filtrar en todas las columnas, columnas
  redimensionables (doble click en el borde las reajusta), cursor con el
  teclado, menú contextual.
- **Inspector de fila**: el valor completo de cada columna — JSON indentado,
  texto con sus saltos, imágenes guardadas como BLOB, volcado hex del resto.
- **Estructura**: columnas, restricciones, índices, claves foráneas, triggers
  y el `CREATE` resaltado.
- **Consola SQL** de solo lectura, con cancelación de verdad.
- **Exportar** a CSV o JSON lo que se ve (con filtro y orden) o el resultado
  de una consulta.
- Recientes, reabrir la última base al arrancar, arrastrar y soltar, abrir
  desde el Explorador (argv / segunda instancia).

## Atajos

| | |
|---|---|
| `Ctrl O` | Abrir base |
| `Ctrl E` | Consola SQL |
| `Ctrl F` | Filtrar la tabla (`Ctrl Shift F`: filtrar el rail) |
| `Ctrl I` | Panel de fila |
| `Ctrl Enter` | Ejecutar la consulta (o solo lo seleccionado) |
| `Ctrl C` | Copiar la celda (entera, aunque el grid la muestre recortada) |
| `F5` | Recargar la base del disco |
| `Ctrl W` | Cerrar la base |

## Cómo está armado

```
main.cjs              ventana (sin flash, de Opal), single-instance, argv
preload.cjs           window.strata: lo único que ve el renderer
src/ipc.cjs           los canales, uno por operación (nada genérico)
src/db.cjs            habla con el proceso de la base; cancelar = matarlo
src/db-worker.cjs     better-sqlite3, en un utilityProcess aparte
src/sqlread.cjs       lo puro: SELECT con orden/filtro, codificar celdas
src/recents.cjs       recientes (las lleva el main)
src/store.cjs         JSON atómico de Opal: ajustes y recientes
renderer/js/app.js    shell: rail, statusbar, comandos, atajos
renderer/js/strata/   grid, inspector, celdas, SQL y las vistas
renderer/css/strata.css   lo propio; el resto es Opal intacto
```

**Por qué un proceso y no un hilo.** better-sqlite3 es sincrónico: en el main
congelaría la ventana. En un `worker_thread` tampoco alcanza, porque un hilo
no se puede matar mientras SQLite está adentro de `sqlite3_step` y
better-sqlite3 no expone `sqlite3_interrupt()`. Un proceso se mata siempre.

**Solo lectura, por tres lados:** conexión `readonly`, `PRAGMA query_only`, y
la consola solo acepta sentencias que SQLite declara lectoras antes de
correrlas. `test/db.test.cjs` compara el hash del archivo antes y después.

**Las celdas viajan con su tipo.** INTEGER, REAL, TEXT y BLOB se distinguen
aunque en JS sean parecidos: `5.0` no se muestra como `5`, un entero de más de
2^53 llega exacto, y los textos largos y blobs viajan recortados (el valor
entero se pide aparte, celda por celda). El formato está en `sqlread.cjs`.

## Diseño

Opal, con acento arenisca (`222 177 118`) y un tinte cálido leve. Se cambia
entero con `node tools/retint.mjs --accent … --hue … --tint …`, que mantiene
en sincronía tokens, splash y el `backgroundColor` de la ventana. La
referencia del sistema está en [docs/sistema.md](docs/sistema.md); en
`npm run dev` la vitrina viva está en el menú de la base (el botón de arriba del
rail), como **Piezas de Opal**. Preferencias (filas compactas, reabrir al
arrancar) viven en ese mismo menú.

Los datos de la app (ajustes, recientes, ventana) viven en `data/` en
desarrollo y en `userData` empaquetada; `STRATA_DATA` los mueve.
