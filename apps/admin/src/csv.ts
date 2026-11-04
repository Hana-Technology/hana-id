// CSV for the audit export (RFC 4180, CRLF), safe to open in a spreadsheet: a text cell that starts with `=`, `+`, `-`,
// `@`, a tab or a carriage return gets a leading `'` so it is never run as a formula (a number, negative ones included,
// is left as it is), and a cell with a comma, a quote, a line break or edge spaces is quoted with its quotes doubled.
// Partner-controlled text (app names, origins, details) reaches these cells, so every cell goes through `csvCell`.

const FORMULA_START = /^[=+\-@\t\r]/u;
const NUMBER = /^-?\d+(\.\d+)?$/u;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  if (typeof v === 'string' && FORMULA_START.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

export const csvRow = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;
