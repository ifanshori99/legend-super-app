// QR table sheet print layout (bead legend-oamb). The QR page prints labels on
// an A4 sheet in a 2-column grid, with page chrome hidden and no label split
// across pages. Contract: apps/web/.../components/qr-sheet-print.ts exports
// QR_SHEET_PRINT_STYLE (CSS text) and QR_SHEET_GRID_CLASS (Tailwind classes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  QR_SHEET_GRID_CLASS,
  QR_SHEET_PRINT_STYLE,
} from "../apps/web/src/features/ws03-floor-editor/components/qr-sheet-print.ts";

const QR_PAGE = new URL(
  "../apps/web/src/features/ws03-floor-editor/components/qr-page.tsx",
  import.meta.url,
);

test("print style sets an A4 page with a 10mm margin", () => {
  assert.match(
    QR_SHEET_PRINT_STYLE,
    /@page\s*\{[^}]*size:\s*A4\s*;[^}]*margin:\s*10mm\s*;[^}]*\}/,
  );
});

test("print style works inside a print media block", () => {
  assert.match(QR_SHEET_PRINT_STYLE, /@media\s+print\s*\{/);
});

test("print style hides everything outside the sheet", () => {
  assert.match(QR_SHEET_PRINT_STYLE, /display:\s*none\s*!important/);
  assert.match(QR_SHEET_PRINT_STYLE, /\.floor-print-sheet/);
});

test("print style keeps each label whole across pages", () => {
  assert.match(
    QR_SHEET_PRINT_STYLE,
    /article[^{]*\{[^}]*break-inside:\s*avoid/,
  );
});

test("print style does not pull the sheet out of flow", () => {
  // position: absolute collapses the sheet to one page, clipping later rows.
  assert.doesNotMatch(QR_SHEET_PRINT_STYLE, /position:\s*absolute/);
});

test("grid is one column by default and two columns when printed", () => {
  const classes = QR_SHEET_GRID_CLASS.split(/\s+/).filter(Boolean);
  assert.ok(classes.includes("grid"));
  assert.ok(classes.includes("print:grid-cols-2"));
  // No unprefixed column class: the base layout is a single column.
  const unprefixedColumns = classes.filter((c) => /^grid-cols-/.test(c));
  assert.deepEqual(unprefixedColumns, []);
});

test("re-issuing a label never rotates the table token", () => {
  const source = readFileSync(QR_PAGE, "utf8");
  assert.doesNotMatch(source, /useRotateTableQr/);
  assert.doesNotMatch(source, /rotateTableQr/);
});
