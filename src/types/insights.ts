import type { CsvColumn } from '../lib/csv';
import type { Severity } from './cluster';

export type ReportColumn = { key: string; header: string; mono: boolean };

export type ReportRow = {
  key: string;
  cells: Record<string, string>;
  severity: Severity | 'good';
};

export type ReportResult = {
  id: string;
  title: string;
  summary: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  degraded_collectors: string[];
};

export type ReportKind = {
  id: string;
  title: string;
  purpose: string;
  filters_namespaces: boolean;
  needs_window: boolean;
  needs_second_context: boolean;
};

export const REPORT_WINDOWS: Array<{ id: string; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

export function windowLabel(id: string): string {
  return REPORT_WINDOWS.find((entry) => entry.id === id)?.label ?? 'Today';
}

/** Counts by severity, so the header can say what the table is full of. */
export function severityCounts(rows: ReportRow[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, serious: 0, warning: 0, good: 0 };
  for (const row of rows) counts[row.severity] = (counts[row.severity] ?? 0) + 1;
  return counts;
}

/**
 * CSV columns derived from the report's own columns, plus the severity that the table
 * carries as a badge. Without it the exported file would lose the ranking the screen
 * shows, and a spreadsheet cannot sort by a colour it never received.
 */
export function csvColumnsFor(result: ReportResult): Array<CsvColumn<ReportRow>> {
  return [
    { header: 'Severity', value: (row) => row.severity },
    ...result.columns.map((column) => ({
      header: column.header,
      value: (row: ReportRow) => row.cells[column.key] ?? '',
    })),
  ];
}

/** Filters rows on any cell, so one search box covers every report's own columns. */
export function filterRows(rows: ReportRow[], needle: string): ReportRow[] {
  const query = needle.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => Object.values(row.cells).some((value) => value.toLowerCase().includes(query)));
}
