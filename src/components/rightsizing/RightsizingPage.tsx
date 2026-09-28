import { useState } from 'react';
import { RefreshCw, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { DiffReview } from '../DiffReview';
import { StatTile } from '../cluster/charts';
import { formatBytes, formatCpu } from '../../lib/format';
import {
  confidenceLabel, workloadKey,
  type HpaPreview, type HpaStatus, type WorkloadDetail, type WorkloadRow,
} from '../../types/rightsizing';
import './rightsizing.css';
import '../yaml-editor.css';

type Props = {
  rows: WorkloadRow[];
  loading: boolean;
  error: string;
  selected: WorkloadRow | null;
  detail: WorkloadDetail | null;
  hpa: HpaStatus | null;
  preview: HpaPreview | null;
  applying: boolean;
  onRefresh: () => void;
  onSelect: (row: WorkloadRow) => void;
  onPreview: (input: {
    minReplicas: number;
    maxReplicas: number;
    targetUtilization: number;
    metric: string;
    importExisting: boolean;
  }) => void;
  onApply: (input: {
    minReplicas: number;
    maxReplicas: number;
    targetUtilization: number;
    metric: string;
    importExisting: boolean;
  }) => void;
  onUndo: () => void;
};

/**
 * Admin-only request vs usage, with an HPA form the server still has to
 * authorise. Hiding this screen is not the control — every call is gated.
 */
export function RightsizingPage({
  rows, loading, error, selected, detail, hpa, preview, applying,
  onRefresh, onSelect, onPreview, onApply, onUndo,
}: Props) {
  const [filter, setFilter] = useState('');
  const [minReplicas, setMinReplicas] = useState(1);
  const [maxReplicas, setMaxReplicas] = useState(10);
  const [target, setTarget] = useState(70);
  const [metric, setMetric] = useState('cpu');
  const [importExisting, setImportExisting] = useState(false);

  if (error && rows.length === 0) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Rightsizing could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((row) => workloadKey(row).toLowerCase().includes(needle))
    : rows;
  const wasted = rows.filter((row) => (row.cpu_waste_milli ?? 0) > 0 || (row.mem_waste_bytes ?? 0) > 0).length;
  const usd = rows.reduce((sum, row) => sum + (row.waste_usd_month ?? 0), 0);
  const limited = rows.filter((row) => row.limited_data).length;
  const low = rows.filter((row) => row.confidence === 'low' || row.confidence === 'none').length;

  const useSuggestion = () => {
    if (!hpa) return;
    setMinReplicas(hpa.suggestion.min_replicas);
    setMaxReplicas(hpa.suggestion.max_replicas);
    setTarget(hpa.suggestion.target_cpu_utilization);
  };

  return (
    <div className={`rs-page ${loading ? 'is-refreshing' : ''}`}>
      <div className="rs-kpis">
        <StatTile label="Workloads" value={String(rows.length)} note="Containers with at least one rollup" severity="good" />
        <StatTile
          label="Over-requested"
          value={wasted > 0 ? String(wasted) : 'none'}
          note={wasted > 0 ? 'Request above the recommendation' : 'Nothing looks oversized yet'}
          severity={wasted > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Est. $/month"
          value={usd > 0 ? `$${usd.toFixed(0)}` : '—'}
          note={usd > 0 ? 'Only if nodes actually consolidate' : 'No public price, or no waste in dollars'}
          severity={usd > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Provisional"
          value={low > 0 || limited > 0 ? String(low + limited) : 'none'}
          note={limited > 0 ? 'Some nodes reported limited data (Fargate / virtual)' : 'Confidence follows days of samples'}
          severity={low > 0 || limited > 0 ? 'warning' : 'good'}
        />
      </div>

      <div className="viz-callout viz-callout-warning">
        <ShieldAlert size={16} aria-hidden />
        <p>
          Reducing requests only lowers the bill if the node autoscaler consolidates nodes.
          A smaller request on a still-full node does not change the invoice.
        </p>
      </div>

      <div className="rs-toolbar">
        <input
          className="rs-filter"
          placeholder="Filter namespace, kind, name…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button type="button" className="viz-toggle" onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="viz-empty viz-empty-page">
          {loading ? 'Reading rollups…' : 'No collector rollups yet. The DaemonSet posts every 5 minutes; day one is a cold start with low confidence.'}
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Workload</th>
                <th>CPU req / p95</th>
                <th>Mem req / peak</th>
                <th>Waste</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  key={workloadKey(row)}
                  className={selected && workloadKey(selected) === workloadKey(row) ? 'selected' : ''}
                  onClick={() => onSelect(row)}
                >
                  <td>
                    <strong>{row.name}</strong>
                    <div className="muted">{row.namespace} · {row.kind} · {row.container}</div>
                  </td>
                  <td className="mono">{formatCpu(row.cpu_request_milli)} / {formatCpu(row.cpu_p95_milli)}</td>
                  <td className="mono">{formatBytes(row.mem_request_bytes)} / {formatBytes(row.mem_max_bytes)}</td>
                  <td>
                    {row.waste_usd_month != null
                      ? `$${row.waste_usd_month.toFixed(0)}/mo`
                      : row.cpu_waste_milli != null || row.mem_waste_bytes != null
                        ? `${formatCpu(row.cpu_waste_milli)} CPU, ${formatBytes(row.mem_waste_bytes)} mem`
                        : '—'}
                  </td>
                  <td>
                    {row.confidence}
                    {row.limited_data ? ' · limited' : ''}
                    {row.oom_kills > 0 ? ' · OOM' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <section className="panel rs-detail">
          <div className="panel-head">
            <span>{detail.row.kind}/{detail.row.name} · {detail.row.container}</span>
            <span className="muted">{confidenceLabel(detail.recommendation.confidence)}</span>
          </div>
          <div className="rs-reason">{detail.recommendation.reason}</div>
          <p className="muted">{detail.notice}</p>
          <div className="rs-rec">
            <div>
              <span>Recommended CPU</span>
              <strong>{formatCpu(detail.recommendation.cpu_request_milli)}</strong>
            </div>
            <div>
              <span>Recommended memory</span>
              <strong>{formatBytes(detail.recommendation.mem_request_bytes)}</strong>
            </div>
          </div>
        </section>
      )}

      {hpa && selected && (
        <section className="panel rs-hpa">
          <div className="panel-head">
            <span><SlidersHorizontal size={14} aria-hidden /> HPA</span>
            <span className="muted">
              {hpa.present ? `${hpa.name}${hpa.ours ? ' · managed by tmjLens' : ' · not ours'}` : 'none on this workload'}
            </span>
          </div>
          {!hpa.manager_enabled && (
            <div className="viz-callout viz-callout-warning">
              <p>HPA manager is disabled on this install (hpaManager.enabled=false). Preview and apply stay blocked.</p>
            </div>
          )}
          {hpa.blocks.map((item) => (
            <div className="viz-callout viz-callout-critical" key={item}><p>{item}</p></div>
          ))}
          {hpa.warnings.map((item) => (
            <div className="viz-callout viz-callout-warning" key={item}><p>{item}</p></div>
          ))}
          <p className="muted">{hpa.suggestion.reason}</p>
          <div className="rs-form">
            <label>Min <input type="number" min={1} value={minReplicas} onChange={(e) => setMinReplicas(Number(e.target.value))} /></label>
            <label>Max <input type="number" min={1} value={maxReplicas} onChange={(e) => setMaxReplicas(Number(e.target.value))} /></label>
            <label>Target % <input type="number" min={1} max={100} value={target} onChange={(e) => setTarget(Number(e.target.value))} /></label>
            <label>Metric
              <select value={metric} onChange={(e) => setMetric(e.target.value)}>
                <option value="cpu">CPU</option>
                <option value="memory">Memory</option>
              </select>
            </label>
          </div>
          {hpa.present && !hpa.ours && (
            <label className="rs-import">
              <input type="checkbox" checked={importExisting} onChange={(e) => setImportExisting(e.target.checked)} />
              Import the existing HPA (required before tmjLens will edit it)
            </label>
          )}
          <div className="rs-actions">
            <button type="button" className="viz-toggle" onClick={useSuggestion}>Use suggestion</button>
            <button
              type="button"
              className="viz-toggle"
              onClick={() => onPreview({ minReplicas, maxReplicas, targetUtilization: target, metric, importExisting })}
            >
              Preview
            </button>
            <button type="button" className="primary" disabled={applying || !preview || preview.blocks.length > 0} onClick={() => onApply({ minReplicas, maxReplicas, targetUtilization: target, metric, importExisting })}>
              Apply
            </button>
            {hpa.ours && (
              <button type="button" className="viz-toggle" onClick={onUndo}>Undo</button>
            )}
          </div>
          {preview && <DiffReview before={preview.before} after={preview.after} />}
        </section>
      )}
    </div>
  );
}
