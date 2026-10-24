/**
 * CSV encoding for exports that staff open in spreadsheet applications.
 *
 * Follows the OWASP "CSV Injection" guidance so user-written text (envelope
 * titles, signer names from public forms, emails) is always read as text:
 *
 *   - a cell whose first character is `=`, `+`, `-`, `@`, tab or CR (or LF,
 *     or one of those after leading whitespace, or a full-width `＝＋－＠`) is
 *     prefixed with a single quote so no spreadsheet evaluates it as a formula;
 *   - every cell is wrapped in double quotes, with embedded quotes doubled, so
 *     a `,` or `;` inside a value can never start a new cell.
 *
 * Every exported cell goes through `csvCell`, not just the ones that look
 * user-controlled today.
 */

const FORMULA_TRIGGER = /^(?:[=+\-@\t\r\n]|\s+[=+\-@]|[＝＋－＠])/;

/** Prefix a value that a spreadsheet would treat as a formula with `'`. */
export function neutraliseFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** One CSV cell: formula-neutralised, always quoted, quotes doubled. */
export function csvCell(value: string | number): string {
  return `"${neutraliseFormula(String(value)).replace(/"/g, '""')}"`;
}

/** One CSV record (no line terminator). */
export function csvRow(values: Array<string | number>): string {
  return values.map(csvCell).join(',');
}
