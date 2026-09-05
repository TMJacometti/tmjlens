import { useEffect, useMemo, useState } from 'react';
import { Check, Download, FileBarChart, Search, ShieldAlert } from 'lucide-react';
import { SeverityBadge } from '../cluster/charts';
import {
  REPORT_WINDOWS, filterRows, severityCounts, windowLabel,
  type ReportKind, type ReportResult,
} from '../../types/insights';
import './reports.css';

export type RunRequest = {
  report: string;
  namespaces: string[];
  window: string;
};

type Props = {
  kinds: ReportKind[];
  namespaces: string[];
  result: ReportResult | null;
  loading: boolean;
  error: string;
  exporting: boolean;
  /** Reads nothing until this is called. */
  onRun: (request: RunRequest) => void;
  onExport: (result: ReportResult) => void;
};

export function ReportsPage({
  kinds, namespaces, result, loading, error, exporting, onRun, onExport,
}: Props) {
  const [reportId, setReportId] = useState(kinds[0]?.id ?? 'deployed');
  const [selected, setSelected] = useState<string[]>([]);
  const [window, setWindow] = useState('today');
  const [search, setSearch] = useState('');
  const [rowFilter, setRowFilter] = useState('');

  const kind = kinds.find((entry) => entry.id === reportId) ?? kinds[0];

  // Changing report changes what the results mean, so a stale table is not left behind.
  useEffect(() => setRowFilter(''), [reportId]);

  const needle = search.trim().toLowerCase();
  const shown = needle ? namespaces.filter((entry) => entry.toLowerCase().includes(needle)) : namespaces;

  const toggle = (entry: string) =>
    setSelected((current) =>
      current.includes(entry) ? current.filter((item) => item !== entry) : [...current, entry],
    );


  const rows = useMemo(() => (result ? filterRows(result.rows, rowFilter) : []), [result, rowFilter]);
  const counts = useMemo(() => (result ? severityCounts(result.rows) : null), [result]);

  return (
    <div className="rep-page">
      <section className="rep-picker">
        <div className="rep-field">
          <span className="rep-label">Report</span>
          <div className="rep-kinds">
            {kinds.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`rep-kind ${entry.id === reportId ? 'is-on' : ''}`}
                aria-pressed={entry.id === reportId}
                onClick={() => setReportId(entry.id)}
              >
                <strong>{entry.title}</strong>
                <span>{entry.purpose}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rep-controls">
          {kind?.needs_window && (
            <div className="rep-field">
              <span className="rep-label">Window</span>
              <div className="wl-switch" role="tablist" aria-label="Time window">
                {REPORT_WINDOWS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={window === entry.id}
                    className={window === entry.id ? 'is-active' : ''}
                    onClick={() => setWindow(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind?.filters_namespaces && (
            <div className="rep-field rep-field-grow">
              <span className="rep-label">
                Namespaces
                <span className="rep-count">
                  {selected.length === 0
                    ? 'none selected — the whole cluster'
                    : `${selected.length} selected`}
                </span>
              </span>

              <div className="rep-ns-tools">
                <input
                  className="wl-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find a namespace…"
                  aria-label="Find a namespace"
                />
                <button type="button" className="viz-toggle" onClick={() => setSelected(shown)}>
                  Select {needle ? 'matching' : 'all'}
                </button>
                <button
                  type="button"
                  className="viz-toggle"
                  onClick={() => setSelected([])}
                  disabled={selected.length === 0}
                >
                  Clear
                </button>
              </div>

              <div className="rep-ns-grid">
                {shown.map((entry) => {
                  const on = selected.includes(entry);
                  return (
                    <button
                      key={entry}
                      type="button"
                      className={`rep-ns ${on ? 'is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggle(entry)}
                    >
                      {on ? <Check size={12} aria-hidden /> : <span className="rep-ns-dot" aria-hidden />}
                      <span className="mono">{entry}</span>
                    </button>
                  );
                })}
                {shown.length === 0 && <p className="viz-dim">No namespace matches.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="rep-run">
          <button
            type="button"
            className="viz-primary"
            disabled={loading}
            onClick={() =>
              onRun({
                report: reportId,
                namespaces: selected,
                window,
              })
            }
          >
            <Search size={14} aria-hidden />
            {loading ? 'Reading…' : 'Run report'}
          </button>
          <span className="viz-dim rep-selection">
            {selected.length === 0
              ? 'Every namespace in the cluster. Narrow it with the filter above if you only want part of it.'
              : `${selected.slice(0, 6).join(', ')}${selected.length > 6 ? ` and ${selected.length - 6} more` : ''}`}
          </span>
        </div>
      </section>

      {error && (
        <div className="viz-callout viz-callout-critical">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>The report could not be built.</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Nothing is listed until a report is run: the screen opens empty on purpose. */}
      {!result && !error && (
        <div className="rep-idle">
          <FileBarChart size={26} aria-hidden />
          <p>Choose a report, set its scope, and select Run report.</p>
          <p className="viz-dim">Nothing is read from the cluster until you do.</p>
        </div>
      )}

      {result && counts && (
        <section className="rep-results">
          <div className="rep-summary">
            <div>
              <strong>{result.summary}</strong>
              <div className="rep-tally">
                {(['critical', 'serious', 'warning'] as const).map((level) =>
                  counts[level] > 0 ? (
                    <span key={level}>
                      <SeverityBadge severity={level} label={`${counts[level]} ${level}`} />
                    </span>
                  ) : null,
                )}
              </div>
            </div>
            <div className="rep-summary-right">
              <input
                className="wl-search"
                value={rowFilter}
                onChange={(event) => setRowFilter(event.target.value)}
                placeholder="Filter rows…"
                aria-label="Filter rows"
              />
              <button
                type="button"
                className="viz-toggle"
                onClick={() => onExport(result)}
                disabled={exporting || result.rows.length === 0}
                title={result.rows.length === 0 ? 'There is nothing to export.' : 'Save this report to Downloads'}
              >
                <Download size={13} aria-hidden /> {exporting ? 'Saving…' : 'Export CSV'}
              </button>
            </div>
          </div>

          {result.degraded_collectors.length > 0 && (
            <div className="viz-callout viz-callout-warning">
              <ShieldAlert size={16} aria-hidden />
              <div>
                <strong>Part of this report is missing.</strong>
                <ul className="rep-degraded">
                  {result.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            </div>
          )}

          {result.rows.length === 0 ? (
            <div className="rep-idle">
              <p>{result.summary}</p>
            </div>
          ) : (
            <table className="viz-table rep-table">
              <thead>
                <tr>
                  <th>State</th>
                  {result.columns.map((column) => <th key={column.key}>{column.header}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      {row.severity === 'good'
                        ? <span className="viz-dim">ok</span>
                        : <SeverityBadge severity={row.severity} />}
                    </td>
                    {result.columns.map((column) => (
                      <td key={column.key} className={column.mono ? 'mono rep-cell' : 'rep-cell'}>
                        {row.cells[column.key] || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={result.columns.length + 1} className="viz-empty">No row matches that filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {result.id === 'deployed' && (
            <p className="viz-dim rep-footnote">Window: {windowLabel(window)}</p>
          )}
        </section>
      )}
    </div>
  );
}
