import { useState } from 'react';
import { CalendarClock, Play, RefreshCw, ShieldAlert, Square, Trash2, Workflow } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  ARGO_VIEWS, argoViewCount, summariseImages,
  type ArgoOverview, type ArgoView, type CronRow, type ImageSlot, type TemplateRow, type WorkflowRow,
} from '../../types/argo';
import { ImageEditorPanel } from './ImageEditorPanel';
import { formatCpuMilli, formatMemoryBytes } from '../../types/metrics';
import type { ResourcesSpec } from '../../types/argo';
import './argo.css';

type EditorTarget = {
  kind: 'WorkflowTemplate' | 'CronWorkflow';
  name: string;
  namespace: string;
  slots: ImageSlot[];
  /** The cron expression, when the target is a single-schedule CronWorkflow. */
  schedule: string | null;
};

type Props = {
  data: ArgoOverview | null;
  loading: boolean;
  error: string;
  capabilities: { patchTemplates: boolean; patchCrons: boolean; createWorkflows: boolean; deleteWorkflows: boolean };
  onRefresh: () => void;
  onSetImage: (target: EditorTarget, slot: ImageSlot, image: string) => Promise<void>;
  onSetResources: (target: EditorTarget, slot: ImageSlot, resources: ResourcesSpec) => Promise<void>;
  onSetSchedule: (target: EditorTarget, expected: string, schedule: string) => Promise<void>;
  onSuspendCron: (row: CronRow, suspend: boolean) => Promise<void>;
  onSubmitTemplate: (row: TemplateRow) => Promise<void>;
  onStopWorkflow: (row: WorkflowRow) => Promise<void>;
  onDeleteWorkflow: (row: WorkflowRow) => Promise<void>;
};

export function ArgoPage({
  data, loading, error, capabilities, onRefresh, onSetImage, onSetResources, onSetSchedule, onSuspendCron, onSubmitTemplate, onStopWorkflow, onDeleteWorkflow,
}: Props) {
  const [view, setView] = useState<ArgoView>('Runs');
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Argo Workflows could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading workflows…' : 'Select Refresh to load.'}</div>;
  }

  if (!data.installed) {
    return (
      <div className="argo-page">
        <div className="viz-callout viz-callout-warning">
          <Workflow size={18} aria-hidden />
          <div>
            <strong>No Argo Workflows in this cluster.</strong>
            <p>{data.reason}</p>
            <p className="viz-dim">
              tmjLens reads Argo's own custom resources through the Kubernetes API — runs, cron workflows and
              templates — under the RBAC you already have. No Argo server or CLI is involved.
            </p>
            <button type="button" className="viz-toggle" onClick={onRefresh}>Check again</button>
          </div>
        </div>
      </div>
    );
  }

  const needle = filter.trim().toLowerCase();
  const matches = <T extends { name: string; namespace: string }>(items: T[]): T[] =>
    needle
      ? items.filter((item) => item.name.toLowerCase().includes(needle) || item.namespace.toLowerCase().includes(needle))
      : items;

  const running = data.workflows.filter((row) => row.phase === 'Running').length;
  const failed = data.workflows.filter((row) => row.health === 'critical').length;
  const suspended = data.cron_workflows.filter((row) => row.suspended).length;

  return (
    <div className={`argo-page ${loading ? 'is-refreshing' : ''}`}>
      <p className="wl-lead">
        Read from Argo's custom resources — the same objects <code>argo list</code> shows. Changing an image
        here changes what the next run uses; runs in flight keep what they started with.
      </p>

      <div className="argo-kpis">
        <StatTile label="Runs" value={String(data.workflows.length)} note={`${running} running now`} />
        <StatTile
          label="Failed runs"
          value={failed > 0 ? String(failed) : 'none'}
          note={failed > 0 ? 'Latest failures ranked first' : 'Nothing failing'}
          severity={failed > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Cron workflows"
          value={String(data.cron_workflows.length)}
          note={suspended > 0 ? `${suspended} suspended` : data.cron_workflows.length ? 'All scheduled' : 'None defined'}
          severity={suspended > 0 ? 'warning' : 'good'}
        />
        <StatTile label="Templates" value={String(data.templates.length)} note="Reusable definitions" />
      </div>

      <div className="argo-toolbar">
        <div className="wl-switch" role="tablist" aria-label="Argo resources">
          {ARGO_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={view === entry ? 'is-active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="viz-count">{argoViewCount(data, entry)}</span>
            </button>
          ))}
        </div>
        <div className="argo-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or namespace…"
            aria-label="Filter"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="argo-degraded">
              {data.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      {view === 'Runs' && (
        <table className="viz-table">
          <thead>
            <tr><th>Run</th><th>Namespace</th><th>State</th><th>Progress</th><th>Live usage</th><th>Duration</th><th>From</th><th>Age</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {matches(data.workflows).map((row) => (
              <tr key={`${row.namespace}/${row.name}`}>
                <td className="mono argo-name">{row.name}</td>
                <td className="mono viz-dim">{row.namespace}</td>
                <td>
                  <SeverityBadge severity={row.health} label={row.phase} />
                  {row.health !== 'good' && <div className="argo-reason">{row.reason}</div>}
                </td>
                <td className="mono">{row.progress ?? '—'}</td>
                <td className="mono argo-usage">
                  {row.cpu_milli !== null || row.memory_bytes !== null
                    ? `${row.cpu_milli !== null ? formatCpuMilli(row.cpu_milli) : '—'} · ${row.memory_bytes !== null ? formatMemoryBytes(row.memory_bytes) : '—'}`
                    : '—'}
                </td>
                <td>{row.duration ?? '—'}</td>
                <td className="mono viz-dim">{row.from_template ?? '—'}</td>
                <td>{row.age}</td>
                <td className="argo-actions">
                  {row.phase === 'Running' && (
                    <button
                      type="button"
                      className="viz-toggle"
                      title="Stop this run. Its exit handlers still execute."
                      onClick={() => void onStopWorkflow(row)}
                    >
                      <Square size={13} aria-hidden /> Stop
                    </button>
                  )}
                  <button
                    type="button"
                    className="viz-toggle viz-danger"
                    disabled={!capabilities.deleteWorkflows}
                    title={capabilities.deleteWorkflows ? `Delete this run and its record` : 'This identity may not delete workflows.'}
                    onClick={() => void onDeleteWorkflow(row)}
                  >
                    <Trash2 size={13} aria-hidden /> Delete
                  </button>
                </td>
              </tr>
            ))}
            {matches(data.workflows).length === 0 && (
              <tr><td colSpan={9} className="viz-empty">No run matches.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Cron workflows' && (
        <table className="viz-table">
          <thead>
            <tr><th>Cron workflow</th><th>Namespace</th><th>State</th><th>Schedule</th><th>Images</th><th>Last run</th><th>Age</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {matches(data.cron_workflows).map((row) => (
              <tr key={`${row.namespace}/${row.name}`} className="argo-row" onClick={() => setEditor({ kind: 'CronWorkflow', name: row.name, namespace: row.namespace, slots: row.images, schedule: row.schedule })}>
                <td><button type="button" className="cfg-link mono">{row.name}</button></td>
                <td className="mono viz-dim">{row.namespace}</td>
                <td>
                  <SeverityBadge severity={row.health} label={row.suspended ? 'Suspended' : 'Scheduled'} />
                  {row.suspended && <div className="argo-reason">{row.reason}</div>}
                </td>
                <td className="mono">{row.schedule}</td>
                <td className="mono argo-images" title={row.images.map((slot) => slot.image).join('\n')}>
                  {summariseImages(row.images)}
                </td>
                <td>{row.last_scheduled ? new Date(row.last_scheduled).toLocaleString() : 'never'}</td>
                <td>{row.age}</td>
                <td className="argo-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="viz-toggle"
                    disabled={!capabilities.patchCrons}
                    title={capabilities.patchCrons ? (row.suspended ? 'Resume the schedule' : 'Suspend the schedule — it stops firing') : 'This identity may not patch cron workflows.'}
                    onClick={() => void onSuspendCron(row, !row.suspended)}
                  >
                    <CalendarClock size={13} aria-hidden /> {row.suspended ? 'Resume' : 'Suspend'}
                  </button>
                </td>
              </tr>
            ))}
            {matches(data.cron_workflows).length === 0 && (
              <tr><td colSpan={8} className="viz-empty">No cron workflow matches.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Templates' && (
        <table className="viz-table">
          <thead>
            <tr><th>Template</th><th>Namespace</th><th>Entrypoint</th><th>Images</th><th>Age</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {matches(data.templates).map((row) => (
              <tr key={`${row.namespace}/${row.name}`} className="argo-row" onClick={() => setEditor({ kind: 'WorkflowTemplate', name: row.name, namespace: row.namespace, slots: row.images, schedule: null })}>
                <td><button type="button" className="cfg-link mono">{row.name}</button></td>
                <td className="mono viz-dim">{row.namespace}</td>
                <td className="mono">{row.entrypoint || '—'}</td>
                <td className="mono argo-images" title={row.images.map((slot) => slot.image).join('\n')}>
                  {summariseImages(row.images)}
                </td>
                <td>{row.age}</td>
                <td className="argo-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="viz-toggle"
                    disabled={!capabilities.createWorkflows}
                    title={capabilities.createWorkflows ? 'Start a run from this template now' : 'This identity may not create workflows.'}
                    onClick={() => void onSubmitTemplate(row)}
                  >
                    <Play size={13} aria-hidden /> Run now
                  </button>
                </td>
              </tr>
            ))}
            {matches(data.templates).length === 0 && (
              <tr><td colSpan={6} className="viz-empty">No workflow template matches.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {editor && (
        <ImageEditorPanel
          kind={editor.kind}
          name={editor.name}
          namespace={editor.namespace}
          slots={editor.slots}
          schedule={editor.schedule}
          canEdit={editor.kind === 'CronWorkflow' ? capabilities.patchCrons : capabilities.patchTemplates}
          onClose={() => setEditor(null)}
          onSaveResources={async (slot, resources) => {
            await onSetResources(editor, slot, resources);
            setEditor((current) =>
              current && {
                ...current,
                slots: current.slots.map((entry) =>
                  entry.template === slot.template && entry.container === slot.container
                    ? { ...entry, resources }
                    : entry,
                ),
              },
            );
          }}
          onSaveSchedule={async (expected, schedule) => {
            await onSetSchedule(editor, expected, schedule);
            setEditor((current) => current && { ...current, schedule });
          }}
          onSave={async (slot, image) => {
            await onSetImage(editor, slot, image);
            // The screen refreshes behind the panel; the panel's slots update locally
            // so the next edit starts from what was just written.
            setEditor((current) =>
              current && {
                ...current,
                slots: current.slots.map((entry) =>
                  entry.template === slot.template && entry.container === slot.container
                    ? { ...entry, image }
                    : entry,
                ),
              },
            );
          }}
        />
      )}
    </div>
  );
}
