import { useMemo, useState } from 'react';
import { ChevronsUpDown, Download, FileCode2, ListTree, RotateCw, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { ActionMenu } from '../ActionMenu';
import { SeverityBadge, StatTile } from '../cluster/charts';
import { WORKLOAD_KINDS, canRestartKind, canScaleKind, type WorkloadInventory, type WorkloadRow } from '../../types/workload-list';

type Props = {
  inventory: WorkloadInventory | null;
  loading: boolean;
  error: string;
  selected: string;
  canDelete: boolean;
  /** Whether this identity may patch the given kind, checked per resource. */
  canPatch: (kind: string) => boolean;
  /** Scale is a separate grant from rollout-restart. Defaults to canPatch. */
  canScale?: (kind: string) => boolean;
  onSelect: (row: WorkloadRow) => void;
  onEditYaml: (row: WorkloadRow) => void;
  onDelete: (row: WorkloadRow) => void;
  onExportYaml: (row: WorkloadRow) => void;
  onScale: (row: WorkloadRow) => void;
  onRestart: (row: WorkloadRow) => void;
};

export function WorkloadInventoryTable({
  inventory,
  loading,
  error,
  selected,
  canDelete,
  canPatch,
  canScale = canPatch,
  onSelect,
  onEditYaml,
  onDelete,
  onExportYaml,
  onScale,
  onRestart,
}: Props) {
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<string>('All');

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (inventory?.rows ?? []).filter(
      (row) =>
        (kind === 'All' || row.kind === kind) &&
        (!needle || row.name.toLowerCase().includes(needle) || row.kind.toLowerCase().includes(needle)),
    );
  }, [inventory, filter, kind]);

  if (error && !inventory) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Workloads could not be read.</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!inventory) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading workloads…' : 'Nothing loaded yet.'}</div>;
  }

  const all = inventory.rows;
  const failing = all.filter((row) => row.health === 'critical').length;
  const degraded = all.filter((row) => row.health === 'serious').length;
  const suspended = all.filter((row) => row.suspended).length;

  // Only the kinds actually present are offered, so the filter never leads nowhere.
  const kinds = ['All', ...WORKLOAD_KINDS.filter((entry) => all.some((row) => row.kind === entry))];

  return (
    <div className="wl-page">
      {inventory.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>This list is partial.</strong>
            <ul>
              {inventory.degraded_collectors.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="wl-kpis">
        <StatTile label="Controllers" value={String(all.length)} note={`${kinds.length - 1} kinds present`} />
        <StatTile
          label="Nothing ready"
          value={String(failing)}
          severity={failing === 0 ? 'good' : 'critical'}
          note={failing === 0 ? 'All serving' : 'No ready pods'}
        />
        <StatTile
          label="Below target"
          value={String(degraded)}
          severity={degraded === 0 ? 'good' : 'serious'}
          note={degraded === 0 ? 'At target' : 'Partially ready'}
        />
        <StatTile
          label="Suspended"
          value={String(suspended)}
          severity={suspended === 0 ? 'good' : 'warning'}
          note={suspended === 0 ? 'None paused' : 'Will not run'}
        />
      </div>

      <div className="wl-toolbar">
        <div className="wl-switch net-switch">
          {kinds.map((entry) => (
            <button key={entry} type="button" className={kind === entry ? 'is-active' : ''} onClick={() => setKind(entry)}>
              {entry}
              {entry !== 'All' && <span className="viz-count">{all.filter((row) => row.kind === entry).length}</span>}
            </button>
          ))}
        </div>
        <label className="wl-search">
          <Search size={14} aria-hidden />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter workloads…"
            aria-label="Filter workloads"
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="viz-card">
          <div className="viz-empty">No workload matches.</div>
        </div>
      ) : (
        <section className="viz-card">
          <div className="viz-table-wrap viz-table-scroll">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>State</th>
                  <th>Ready</th>
                  <th>What it means</th>
                  <th>Image</th>
                  <th>Age</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = `${row.kind}/${row.name}`;
                  const share = row.desired > 0 ? (row.ready / row.desired) * 100 : 100;
                  return (
                    <tr key={key} className={selected === key ? 'is-selected' : ''} onClick={() => onSelect(row)}>
                      <td>{row.kind}</td>
                      <td className="mono">{row.name}</td>
                      <td>
                        <SeverityBadge
                          severity={row.health}
                          label={row.suspended ? 'Suspended' : row.health === 'good' ? 'Ready' : undefined}
                        />
                      </td>
                      <td>
                        <div className="wl-replicas">
                          {/* A bar needs a target to fill. A CronJob counts active runs
                              and a scaled-to-zero controller has none, so filling the
                              track there would claim a completeness that is not real. */}
                          {row.desired > 0 ? (
                            <div className="viz-track viz-track-thin">
                              <div
                                className="viz-bar"
                                style={{ width: `${Math.min(share, 100)}%`, background: `var(--status-${row.health})` }}
                              />
                            </div>
                          ) : (
                            <span className="viz-dim wl-no-target">no target</span>
                          )}
                          <span>
                            {row.ready}/{row.desired}
                          </span>
                        </div>
                      </td>
                      <td className="wl-meaning">{row.detail}</td>
                      <td className="mono wl-image" title={row.images.join('\n')}>
                        {row.images[0] ?? '—'}
                        {row.images.length > 1 && <span className="viz-dim"> +{row.images.length - 1}</span>}
                      </td>
                      <td>{row.age}</td>
                      <td className="wl-actions" onClick={(event) => event.stopPropagation()}>
                        <ActionMenu
                          label={`${row.kind} actions`}
                          items={[
                            { label: 'Open details', icon: <ListTree size={14} />, onSelect: () => onSelect(row) },
                            ...(canScaleKind(row.kind) && canScale(row.kind)
                              ? [{ label: 'Scale…', icon: <ChevronsUpDown size={14} />, onSelect: () => onScale(row) }]
                              : []),
                            ...(canRestartKind(row.kind) && canPatch(row.kind)
                              ? [{ label: 'Rollout restart', icon: <RotateCw size={14} />, onSelect: () => onRestart(row) }]
                              : []),
                            { label: 'Edit YAML', icon: <FileCode2 size={14} />, onSelect: () => onEditYaml(row) },
                            { label: 'Download YAML', icon: <Download size={14} />, onSelect: () => onExportYaml(row) },
                            ...(canDelete
                              ? [{ label: `Delete ${row.kind.toLowerCase()}`, icon: <Trash2 size={14} />, danger: true, onSelect: () => onDelete(row) }]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
