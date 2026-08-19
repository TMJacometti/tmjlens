import { useState } from 'react';
import { Check, Download, Rocket, Search, ShieldAlert, X } from 'lucide-react';
import { SeverityBadge } from '../cluster/charts';
import {
  REPORT_WINDOWS, formatDeployDate, formatDeployTime, groupByNamespace, shortImage, summarise,
  windowLabel, type DeployReport,
} from '../../types/reports';
import './reports.css';

type Props = {
  namespaces: string[];
  report: DeployReport | null;
  loading: boolean;
  error: string;
  /** Runs only when asked. Nothing is read before the operator picks and filters. */
  onRun: (namespaces: string[], window: string) => void;
  onExport: (report: DeployReport) => void;
  exporting: boolean;
};

export function DeployReportPage({ namespaces, report, loading, error, onRun, onExport, exporting }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [window, setWindow] = useState('today');
  const [search, setSearch] = useState('');

  const needle = search.trim().toLowerCase();
  const shown = needle ? namespaces.filter((entry) => entry.toLowerCase().includes(needle)) : namespaces;

  const toggle = (entry: string) =>
    setSelected((current) =>
      current.includes(entry) ? current.filter((item) => item !== entry) : [...current, entry],
    );

  return (
    <div className="rep-page">
      <section className="rep-picker">
        <div className="rep-picker-head">
          <div>
            <h2>What was deployed</h2>
            <p>
              Workloads that did not exist in the cluster before the window began — deployments, stateful sets,
              daemon sets, cron jobs, hand-started jobs and Argo workflows. A job a cron job started is a
              scheduled run, not a deployment, so it is left out.
            </p>
          </div>
        </div>

        <div className="rep-controls">
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

          <div className="rep-field rep-field-grow">
            <span className="rep-label">
              Namespaces
              <span className="rep-count">
                {selected.length === 0 ? 'none selected' : `${selected.length} selected`}
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
        </div>

        <div className="rep-run">
          <button
            type="button"
            className="viz-primary"
            disabled={selected.length === 0 || loading}
            onClick={() => onRun(selected, window)}
            title={selected.length === 0 ? 'Pick at least one namespace first.' : undefined}
          >
            <Search size={14} aria-hidden />
            {loading ? 'Reading…' : `Filter ${windowLabel(window).toLowerCase()}`}
          </button>
          {selected.length > 0 && (
            <span className="viz-dim rep-selection">
              {selected.slice(0, 6).join(', ')}
              {selected.length > 6 ? ` and ${selected.length - 6} more` : ''}
            </span>
          )}
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

      {/* Nothing is listed until a filter is run: the screen opens empty on purpose. */}
      {!report && !error && (
        <div className="rep-idle">
          <Rocket size={26} aria-hidden />
          <p>Pick one or more namespaces and select Filter.</p>
          <p className="viz-dim">Nothing is read from the cluster until you do.</p>
        </div>
      )}

      {report && <Results report={report} onExport={onExport} exporting={exporting} />}
    </div>
  );
}

function Results({
  report, onExport, exporting,
}: {
  report: DeployReport;
  onExport: (report: DeployReport) => void;
  exporting: boolean;
}) {
  const groups = groupByNamespace(report.items);

  return (
    <section className="rep-results">
      <div className="rep-summary">
        <strong>{summarise(report)}</strong>
        <div className="rep-summary-right">
          <span className="viz-dim">{windowLabel(report.window)}</span>
          <button
            type="button"
            className="viz-toggle"
            onClick={() => onExport(report)}
            disabled={exporting || report.items.length === 0}
            title={report.items.length === 0 ? 'There is nothing to export.' : 'Save this report to Downloads'}
          >
            <Download size={13} aria-hidden /> {exporting ? 'Saving…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {report.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this report is missing.</strong>
            <ul className="rep-degraded">
              {report.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      {report.items.length === 0 ? (
        <div className="rep-idle">
          <X size={24} aria-hidden />
          <p>Nothing was deployed {windowLabel(report.window).toLowerCase()} in {report.namespaces.join(', ')}.</p>
        </div>
      ) : (
        groups.map(([namespace, items]) => (
          <div key={namespace} className="rep-group">
            <h3 className="mono">
              {namespace} <span className="viz-count">{items.length}</span>
            </h3>
            <table className="viz-table">
              <thead>
                <tr><th>Workload</th><th>Kind</th><th>State</th><th>Detail</th><th>Image</th><th>Deployed by</th><th>At</th></tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.kind}-${item.name}`}>
                    <td className="mono">{item.name}</td>
                    <td className="viz-dim">{item.kind}</td>
                    <td>
                      <SeverityBadge severity={item.health} />
                      <div className="rep-reason">{item.reason}</div>
                    </td>
                    <td className="mono rep-detail">{item.detail}</td>
                    <td className="rep-images">
                      {item.images.length === 0 ? '—' : item.images.map((image) => (
                        <div key={image} className="mono" title={image}>{shortImage(image)}</div>
                      ))}
                    </td>
                    <td className="viz-dim">{item.managed_by ?? 'by hand'}</td>
                    <td>
                      <div>{formatDeployTime(item.deployed_at)}</div>
                      <div className="viz-dim rep-date">{formatDeployDate(item.deployed_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}
