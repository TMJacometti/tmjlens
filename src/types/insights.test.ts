import { describe, expect, it } from 'vitest';
import { csvColumnsFor, filterRows, severityCounts, windowLabel, type ReportResult, type ReportRow } from './insights';
import { toCsv } from '../lib/csv';

const row = (key: string, severity: ReportRow['severity'], cells: Record<string, string>): ReportRow =>
  ({ key, severity, cells });

const result: ReportResult = {
  id: 'idle-cost',
  title: 'Idle cost',
  summary: '2 idle items.',
  columns: [
    { key: 'namespace', header: 'Namespace', mono: true },
    { key: 'name', header: 'Name', mono: true },
    { key: 'why', header: 'Why it is idle', mono: false },
  ],
  rows: [
    row('a', 'critical', { namespace: 'payments', name: 'pvc-3d1f', why: 'Released with Retain.' }),
    row('b', 'warning', { namespace: 'ledger', name: 'old-config', why: 'No running pod reads it.' }),
  ],
  degraded_collectors: [],
};

describe('severity counts', () => {
  it('counts each level so the header can say what the table holds', () => {
    const counts = severityCounts(result.rows);
    expect(counts.critical).toBe(1);
    expect(counts.warning).toBe(1);
    expect(counts.serious).toBe(0);
  });

  it('starts every level at zero rather than leaving it undefined', () => {
    const counts = severityCounts([]);
    expect(counts).toEqual({ critical: 0, serious: 0, warning: 0, good: 0 });
  });
});

describe('row filtering', () => {
  it('matches on any cell, since each report has its own columns', () => {
    expect(filterRows(result.rows, 'ledger')).toHaveLength(1);
    expect(filterRows(result.rows, 'retain')).toHaveLength(1);
    expect(filterRows(result.rows, 'pvc-3d1f')).toHaveLength(1);
  });

  it('is case-insensitive and ignores surrounding space', () => {
    expect(filterRows(result.rows, '  PAYMENTS ')).toHaveLength(1);
  });

  it('returns everything for an empty filter', () => {
    expect(filterRows(result.rows, '')).toHaveLength(2);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterRows(result.rows, 'zzz')).toHaveLength(0);
  });
});

describe('csv columns', () => {
  it('leads with severity, which the table carries as a badge', () => {
    // Without it the export loses the ranking the screen shows, and a spreadsheet
    // cannot sort by a colour it never received.
    const columns = csvColumnsFor(result);
    expect(columns[0].header).toBe('Severity');
    expect(columns.map((column) => column.header)).toEqual([
      'Severity', 'Namespace', 'Name', 'Why it is idle',
    ]);
  });

  it('produces a document whose rows line up with the report', () => {
    const csv = toCsv(csvColumnsFor(result), result.rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Severity,Namespace,Name,Why it is idle');
    expect(lines[1]).toBe('critical,payments,pvc-3d1f,Released with Retain.');
  });

  it('writes an empty cell for a column a row does not carry', () => {
    const sparse: ReportResult = { ...result, rows: [row('c', 'good', { namespace: 'payments' })] };
    const csv = toCsv(csvColumnsFor(sparse), sparse.rows);
    expect(csv.split('\r\n')[1]).toBe('good,payments,,');
  });
});

describe('window labels', () => {
  it('names each window and falls back rather than showing a raw id', () => {
    expect(windowLabel('today')).toBe('Today');
    expect(windowLabel('7d')).toBe('Last 7 days');
    expect(windowLabel('nonsense')).toBe('Today');
  });
});
