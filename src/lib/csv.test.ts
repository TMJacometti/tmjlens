import { describe, expect, it } from 'vitest';
import { escapeCsvValue, reportFileName, toCsv, withExcelBom } from './csv';

describe('escaping', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCsvValue('checkout-api')).toBe('checkout-api');
    expect(escapeCsvValue(42)).toBe('42');
  });

  it('quotes a value holding a comma', () => {
    expect(escapeCsvValue('a, b')).toBe('"a, b"');
  });

  it('doubles inner quotes', () => {
    expect(escapeCsvValue('he said "no"')).toBe('"he said ""no"""');
  });

  it('quotes a value spanning lines, so it stays one cell', () => {
    expect(escapeCsvValue('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes an empty cell for nothing', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('joins a list into one cell', () => {
    expect(escapeCsvValue(['a', 'b'])).toBe('a; b');
  });
});

describe('formula injection', () => {
  it('neutralises every character a spreadsheet treats as a formula', () => {
    // These arrive from the cluster — an image tag, a message, someone else's
    // annotation — and would otherwise execute when the file is opened.
    expect(escapeCsvValue('=1+1')).toBe("'=1+1");
    expect(escapeCsvValue('+1')).toBe("'+1");
    expect(escapeCsvValue('-1')).toBe("'-1");
    expect(escapeCsvValue('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('neutralises the classic command-execution payload', () => {
    const payload = '=cmd|\' /c calc\'!A1';
    const escaped = escapeCsvValue(payload);
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped).not.toMatch(/^"?=/);
  });

  it('still quotes a dangerous value that also holds a comma', () => {
    expect(escapeCsvValue('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('does not touch a value that merely contains an equals sign', () => {
    expect(escapeCsvValue('app=checkout')).toBe('app=checkout');
  });

  it('does not mangle a negative number that is genuinely a number', () => {
    // Prefixed rather than dropped: the cell still reads -3, it just is not a formula.
    expect(escapeCsvValue(-3)).toBe("'-3");
  });
});

describe('documents', () => {
  const rows = [
    { name: 'checkout-api', replicas: 3, reason: 'All 3 replicas ready.' },
    { name: 'fraud-scoring', replicas: 0, reason: 'None of 2 replicas are ready, "again".' },
  ];
  const columns = [
    { header: 'Workload', value: (row: (typeof rows)[number]) => row.name },
    { header: 'Replicas', value: (row: (typeof rows)[number]) => row.replicas },
    { header: 'Reason', value: (row: (typeof rows)[number]) => row.reason },
  ];

  it('writes a header and one line per row, separated by CRLF', () => {
    const csv = toCsv(columns, rows);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Workload,Replicas,Reason');
    expect(lines[1]).toBe('checkout-api,3,All 3 replicas ready.');
    expect(lines[2]).toBe('fraud-scoring,0,"None of 2 replicas are ready, ""again""."');
  });

  it('writes just the header when there are no rows', () => {
    expect(toCsv(columns, [])).toBe('Workload,Replicas,Reason');
  });

  it('prefixes a byte-order mark so Excel reads it as UTF-8', () => {
    const marked = withExcelBom('a,b');
    expect(marked.charCodeAt(0)).toBe(0xfeff);
    expect(marked.slice(1)).toBe('a,b');
  });
});

describe('file names', () => {
  it('names the namespace when there is one', () => {
    expect(reportFileName('Deploy report', ['payments'])).toBe('deploy-report-payments');
  });

  it('counts them when there are several, rather than growing without bound', () => {
    expect(reportFileName('Deploy report', ['a', 'b', 'c'])).toBe('deploy-report-3-namespaces');
  });

  it('drops the suffix when there is no scope', () => {
    expect(reportFileName('Deploy report', [])).toBe('deploy-report');
  });
});
