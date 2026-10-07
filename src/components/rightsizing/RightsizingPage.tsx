import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, RefreshCw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react';
import { DiffReview } from '../DiffReview';
import { StatTile } from '../cluster/charts';
import { formatBytes, formatCpu } from '../../lib/format';
import {
  confidenceLabel, workloadKey,
  DETAIL_TABS, namespacesOf, resourcesInputFrom, resourcesInputToRequest, sortRows,
  type CollectorCoverage, type DetailTab, type SortDir, type SortKey, type HpaPreview, type HpaStatus, type ResourcesInput, type ResourcesPreview,
  type ResourcesStatus, type WorkloadDetail, type WorkloadRow,
} from '../../types/rightsizing';
import './rightsizing.css';
import '../yaml-editor.css';

type Props = {
  rows: WorkloadRow[];
  /** Which nodes the collector actually runs on; null while unknown. */
  coverage: CollectorCoverage | null;
  loading: boolean;
  error: string;
  selected: WorkloadRow | null;
  detail: WorkloadDetail | null;
  hpa: HpaStatus | null;
  preview: HpaPreview | null;
  /** The container's requests/limits today, the recommendation, and the guards. */
  resources: ResourcesStatus | null;
  resourcesPreview: ResourcesPreview | null;
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
  onResourcesPreview: (input: ResourcesInput) => void;
  onResourcesApply: (input: ResourcesInput) => void;
  onResourcesUndo: () => void;
  /** Closes the detail popup and clears the selection. */
  onClose: () => void;
  /** Drops a preview without applying it. */
  onDismissPreview: () => void;
  onDismissResourcesPreview: () => void;
};

/**
 * Admin-only request vs usage, with an HPA form the server still has to
 * authorise. Hiding this screen is not the control — every call is gated.
 */
export function RightsizingPage({
  rows, coverage, loading, error, selected, detail, hpa, preview, applying,
  resources, resourcesPreview,
  onRefresh, onSelect, onPreview, onApply, onUndo,
  onResourcesPreview, onResourcesApply, onResourcesUndo, onClose,
  onDismissPreview, onDismissResourcesPreview,
}: Props) {
  // The detail is a popup over the table: panels that lived below the fold
  // read as "nothing happened" to anyone who did not know to scroll.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onClose]);
  const [filter, setFilter] = useState('');
  const [minReplicas, setMinReplicas] = useState(1);
  const [maxReplicas, setMaxReplicas] = useState(10);
  const [target, setTarget] = useState(70);
  const [metric, setMetric] = useState('cpu');
  const [importExisting, setImportExisting] = useState(false);
  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('waste');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [tab, setTab] = useState<DetailTab>('Overview');
  const selectedKey = selected ? workloadKey(selected) : '';
  // A new workload opens on its Overview, whatever tab the last one was on.
  useEffect(() => { setTab('Overview'); }, [selectedKey]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };
  const sortIcon = (key: SortKey) =>
    key !== sortKey ? null : sortDir === 'desc' ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />;
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    key !== sortKey ? 'none' : sortDir === 'asc' ? 'ascending' : 'descending';

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
  const narrowed = rows.filter((row) =>
    (!namespaceFilter || row.namespace === namespaceFilter)
    && (!needle || workloadKey(row).toLowerCase().includes(needle)));
  const shown = sortRows(narrowed, sortKey, sortDir);
  const namespaces = namespacesOf(rows);
  const wasted = rows.filter((row) => (row.cpu_waste_milli ?? 0) > 0 || (row.mem_waste_bytes ?? 0) > 0).length;
  const usd = rows.reduce((sum, row) => sum + (row.waste_usd_month ?? 0), 0);
  const limited = rows.filter((row) => row.limited_data).length;
  const low = rows.filter((row) => row.confidence === 'low' || row.confidence === 'none').length;

  // Edited in millicores and MiB. Blank keeps a field unset — a limit that
  // was never there is not invented, and one that exists is kept unless typed.
  const [resFields, setResFields] = useState({ cpuRequest: '', cpuLimit: '', memRequest: '', memLimit: '' });
  useEffect(() => {
    if (resources) setResFields(resourcesInputFrom(resources.recommended));
  }, [resources]);
  const useRecommendation = () => {
    if (resources) setResFields(resourcesInputFrom(resources.recommended));
  };
  const useCurrent = () => {
    if (resources) setResFields(resourcesInputFrom(resources.current));
  };
  const resourcesInput = () => resourcesInputToRequest(resFields);

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

      {coverage && !coverage.collector_found && (
        <div className="viz-callout viz-callout-critical">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>No collector is running.</strong>
            <p>
              Nothing on this screen is being measured right now — the rows below are history,
              not the present. Check the tmjlens-collector DaemonSet.
            </p>
          </div>
        </div>
      )}
      {coverage && coverage.collector_found && coverage.missing.length > 0 && (
        <div className="viz-callout viz-callout-critical">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>
              The collector runs on {coverage.nodes_covered} of {coverage.nodes_total} nodes — workloads on
              the other {coverage.missing.length} are NOT measured.
            </strong>
            <ul className="rs-missing">
              {coverage.missing.map((entry) => (
                <li key={entry.node}>
                  <span className="mono">{entry.node}</span> — {entry.reason}
                </li>
              ))}
            </ul>
            <p>
              "Too many pods" means the node is out of pod slots: raise the node group's max pods,
              or set <code>collector.priorityClassName</code> in the chart so the collector may
              preempt a lower-priority pod to fit.
            </p>
          </div>
        </div>
      )}

      <div className="viz-callout viz-callout-warning">
        <ShieldAlert size={16} aria-hidden />
        <p>
          Reducing requests only lowers the bill if the node autoscaler consolidates nodes.
          A smaller request on a still-full node does not change the invoice.
        </p>
      </div>

      <div className="rs-toolbar">
        <select
          className="rs-namespace"
          aria-label="Namespace"
          value={namespaceFilter}
          onChange={(event) => setNamespaceFilter(event.target.value)}
        >
          <option value="">All namespaces ({rows.length})</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns} ({rows.filter((row) => row.namespace === ns).length})</option>
          ))}
        </select>
        <input
          className="rs-filter"
          placeholder="Filter kind, name, container…"
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
                <th aria-sort={ariaSort('name')}><button type="button" className="rs-sort" onClick={() => toggleSort('name')}>Workload {sortIcon('name')}</button></th>
                <th aria-sort={ariaSort('cpu')}><button type="button" className="rs-sort" onClick={() => toggleSort('cpu')}>CPU req / p95 {sortIcon('cpu')}</button></th>
                <th aria-sort={ariaSort('mem')}><button type="button" className="rs-sort" onClick={() => toggleSort('mem')}>Mem req / peak {sortIcon('mem')}</button></th>
                <th aria-sort={ariaSort('waste')}><button type="button" className="rs-sort" onClick={() => toggleSort('waste')}>Waste {sortIcon('waste')}</button></th>
                <th aria-sort={ariaSort('confidence')}><button type="button" className="rs-sort" onClick={() => toggleSort('confidence')}>Confidence {sortIcon('confidence')}</button></th>
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
                    <div className="muted">
                      {row.namespace} · {row.kind} · {row.container}
                      {!row.live_spec && <span className="rs-gone"> · no longer in the cluster — history only</span>}
                    </div>
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

      {selected && createPortal(
        <div className="yaml-scrim" onClick={onClose}>
          <section
            className="rs-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Rightsizing ${selected.kind}/${selected.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="yaml-head">
              <div>
                <h2 className="mono">{selected.name}</h2>
                <p>{selected.namespace} · {selected.kind} · container {selected.container}</p>
              </div>
              <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
                <X size={14} aria-hidden />
              </button>
            </header>
            <div className="wl-switch rs-tabs" role="tablist" aria-label="Workload detail">
              {DETAIL_TABS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry}
                  className={tab === entry ? 'is-active' : ''}
                  onClick={() => setTab(entry)}
                >
                  {entry}
                </button>
              ))}
            </div>
            <div className="rs-modal-body">
      {tab === 'Overview' && !detail && <div className="viz-empty">Reading the recommendation…</div>}
      {tab === 'Overview' && detail && (
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

      {tab === 'HPA' && !hpa && <div className="viz-empty">Reading the HPA…</div>}
      {tab === 'HPA' && hpa && (
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
          {hpa.blocks
            // The install-flag block is already the callout above; say it once.
            .filter((item) => !item.startsWith('HPA manager is disabled'))
            .map((item) => (
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
          {!preview && (
            <div className="rs-actions">
              <button type="button" className="viz-toggle" onClick={useSuggestion}>Use suggestion</button>
              <button
                type="button"
                className="primary"
                onClick={() => onPreview({ minReplicas, maxReplicas, targetUtilization: target, metric, importExisting })}
              >
                Preview
              </button>
              {hpa.ours && (
                <button type="button" className="viz-toggle" onClick={onUndo}>Undo</button>
              )}
            </div>
          )}
          {preview && (
            <div className="rs-review" role="region" aria-label="HPA change under review">
              {preview.blocks.map((item) => (
                <div className="viz-callout viz-callout-critical" key={`p-${item}`}><p>{item}</p></div>
              ))}
              {preview.warnings.map((item) => (
                <div className="viz-callout viz-callout-warning" key={`p-${item}`}><p>{item}</p></div>
              ))}
              <DiffReview before={preview.before} after={preview.after} />
              <div className="rs-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={applying || preview.blocks.length > 0}
                  onClick={() => onApply({ minReplicas, maxReplicas, targetUtilization: target, metric, importExisting })}
                >
                  Apply
                </button>
                <button type="button" className="viz-toggle" onClick={onDismissPreview}>Back to the form</button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'Resources' && !resources && (
        <div className="viz-empty">This workload has no pod template tmjLens edits (Jobs and CronJobs), or it could not be read.</div>
      )}
      {tab === 'Resources' && resources && (
        <section className="panel rs-resources">
          <div className="panel-head">
            <span><SlidersHorizontal size={14} aria-hidden /> Resources</span>
            <span className="muted">
              {selected.kind}/{selected.name} · container {selected.container}
              {resources.ours ? ' · set by tmjLens' : ''}
            </span>
          </div>
          {!resources.editor_enabled && (
            <div className="viz-callout viz-callout-warning">
              <p>Resource editor is disabled on this install (resourceEditor.enabled=false). Preview and apply stay blocked.</p>
            </div>
          )}
          {resources.blocks
            // The install-flag block is already the callout above; say it once.
            .filter((item) => !item.startsWith('Resource editor is disabled'))
            .map((item) => (
              <div className="viz-callout viz-callout-critical" key={item}><p>{item}</p></div>
            ))}
          {resources.warnings.map((item) => (
            <div className="viz-callout viz-callout-warning" key={item}><p>{item}</p></div>
          ))}
          <div className="rs-compare">
            <div>
              <span>Current CPU req / limit</span>
              <strong>{formatCpu(resources.current.cpu_request_milli)} / {formatCpu(resources.current.cpu_limit_milli)}</strong>
            </div>
            <div>
              <span>Current memory req / limit</span>
              <strong>{formatBytes(resources.current.mem_request_bytes)} / {formatBytes(resources.current.mem_limit_bytes)}</strong>
            </div>
            <div>
              <span>Recommended CPU request</span>
              <strong>{formatCpu(resources.recommended.cpu_request_milli)}</strong>
            </div>
            <div>
              <span>Recommended memory request</span>
              <strong>{formatBytes(resources.recommended.mem_request_bytes)}</strong>
            </div>
          </div>
          <div className="rs-form">
            <label>CPU request (m)
              <input type="number" min={1} value={resFields.cpuRequest} aria-label="CPU request millicores"
                onChange={(e) => setResFields({ ...resFields, cpuRequest: e.target.value })} />
            </label>
            <label>CPU limit (m)
              <input type="number" min={1} value={resFields.cpuLimit} aria-label="CPU limit millicores" placeholder="unset"
                onChange={(e) => setResFields({ ...resFields, cpuLimit: e.target.value })} />
            </label>
            <label>Memory request (MiB)
              <input type="number" min={1} value={resFields.memRequest} aria-label="Memory request MiB"
                onChange={(e) => setResFields({ ...resFields, memRequest: e.target.value })} />
            </label>
            <label>Memory limit (MiB)
              <input type="number" min={1} value={resFields.memLimit} aria-label="Memory limit MiB" placeholder="unset"
                onChange={(e) => setResFields({ ...resFields, memLimit: e.target.value })} />
            </label>
          </div>
          <p className="muted">
            Applying changes the pod template, so the workload rolls ({resources.replicas} replica(s) restart).
            Limits are kept as they are unless you type them; a request above its limit is refused before anything is sent.
          </p>
          {!resourcesPreview && (
            <div className="rs-actions">
              <button type="button" className="viz-toggle" onClick={useRecommendation}>Use recommendation</button>
              <button type="button" className="viz-toggle" onClick={useCurrent}>Reset to current</button>
              <button type="button" className="primary" onClick={() => onResourcesPreview(resourcesInput())}>
                Preview resources
              </button>
              {resources.ours && (
                <button type="button" className="viz-toggle" onClick={onResourcesUndo}>Undo resources</button>
              )}
            </div>
          )}
          {resourcesPreview && (
            <div className="rs-review" role="region" aria-label="Resources change under review">
              {resourcesPreview.blocks.map((item) => (
                <div className="viz-callout viz-callout-critical" key={`p-${item}`}><p>{item}</p></div>
              ))}
              {resourcesPreview.warnings.map((item) => (
                <div className="viz-callout viz-callout-warning" key={`p-${item}`}><p>{item}</p></div>
              ))}
              <DiffReview before={resourcesPreview.before} after={resourcesPreview.after} />
              <div className="rs-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={applying || resourcesPreview.blocks.length > 0}
                  onClick={() => onResourcesApply(resourcesInput())}
                >
                  Apply resources
                </button>
                <button type="button" className="viz-toggle" onClick={onDismissResourcesPreview}>Back to the form</button>
              </div>
            </div>
          )}
        </section>
      )}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
