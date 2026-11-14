// Print rules and grid for the table QR label sheet (legend-oamb).
//
// A4 portrait with a 10 mm margin leaves 190 mm of width: two labels per row
// with a 4 mm gap (93 mm each) at every print size. On screen the grid grows
// with the viewport (1 / 2 / 3 columns), but paper always gets 2 columns, so a
// wide monitor never prints a 3-column sheet that cuts labels off.
//
// Same approach as the prep label sheet (operations-food-safety): every node
// that neither is nor contains the sheet is removed from layout with
// `display: none`, not just hidden, so the app shell cannot add blank pages
// after the labels. Reprinting only reads the stored token; rotating is the
// separate "Ganti QR" action.

export const QR_SHEET_PRINT_STYLE = `@page { size: A4; margin: 10mm; }
@media print {
  html, body {
    height: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
    background: transparent !important;
  }
  body *:not(.floor-print-sheet):not(.floor-print-sheet *):not(:has(.floor-print-sheet)) {
    display: none !important;
  }
  body *:has(.floor-print-sheet):not([role="dialog"]):not([popover]) {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    overflow: visible !important;
    box-shadow: none !important;
    background: transparent !important;
  }
  .floor-print-sheet {
    box-sizing: border-box;
    width: 100%;
    padding: 0;
  }
  .floor-print-sheet article {
    break-inside: avoid;
    page-break-inside: avoid;
    box-shadow: none !important;
  }
}`;

export const QR_SHEET_GRID_CLASS =
  "grid gap-3 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2 print:gap-[4mm]";
