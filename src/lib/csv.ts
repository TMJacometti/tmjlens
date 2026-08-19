/**
 * CSV generation for exported reports.
 *
 * Two hazards are handled here rather than left to the caller.
 *
 * The first is ordinary quoting: a value holding a comma, a quote or a newline has to
 * be wrapped and its quotes doubled, or the file silently gains columns.
 *
 * The second is formula injection. A spreadsheet treats a cell beginning with `=`, `+`,
 * `-`, `@`, tab or carriage return as a formula, so a value that arrived from a cluster
 * — an image tag, a condition message, an annotation someone else wrote — can execute
 * when the file is opened. Such values are prefixed with an apostrophe, which Excel and
 * LibreOffice both read as "this is text". The cell reads the same; it just does not run.
 */

const NEEDS_QUOTING = /[",\n\r]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = Array.isArray(value) ? value.join('; ') : String(value);

  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

/**
 * Builds a CSV document from typed columns.
 *
 * Rows are joined with CRLF, which is what RFC 4180 specifies and what Excel on Windows
 * expects; a file with bare newlines opens as one long row in some versions.
 */
export function toCsv<T>(columns: Array<CsvColumn<T>>, rows: T[]): string {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsvValue(column.value(row))).join(','));
  return [header, ...body].join('\r\n');
}

/**
 * A byte-order mark, so Excel reads the file as UTF-8.
 *
 * Without it, Excel on Windows falls back to the system code page and every accented
 * namespace or message arrives mangled. Other tools ignore the mark.
 */
export function withExcelBom(csv: string): string {
  return `﻿${csv}`;
}

/** A file name that is stable to read and sorts sensibly in a folder. */
export function reportFileName(prefix: string, scope: string[]): string {
  const cleaned = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (scope.length === 0) return cleaned;
  if (scope.length === 1) return `${cleaned}-${scope[0]}`;
  return `${cleaned}-${scope.length}-namespaces`;
}
