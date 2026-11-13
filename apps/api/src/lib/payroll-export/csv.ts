// RFC 4180 CSV helpers for payroll exports. Cells that a spreadsheet could read
// as a formula are neutralised with a leading apostrophe (CSV injection).
const CRLF = "\r\n";
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// Quotes only when RFC 4180 requires it (comma, quote, CR, LF) or `forceQuote`.
export function csvCell(
  value: string | number | null | undefined,
  options: { forceQuote?: boolean } = {},
): string {
  const text = neutralizeFormula(
    value === null || value === undefined ? "" : String(value),
  );
  if (options.forceQuote || /[",\r\n]/.test(text)) return quote(text);
  return text;
}

// Rows are joined with CRLF and there is no trailing line break.
export function csvRows(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join(",")).join(CRLF);
}
