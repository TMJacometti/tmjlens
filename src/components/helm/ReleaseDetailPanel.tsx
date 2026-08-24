import { useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, X } from 'lucide-react';
import { SeverityBadge } from '../cluster/charts';
import { DETAIL_TABS, formatDeployedAt, type DetailTab, type ReleaseDetail } from '../../types/helm';
import type { Severity } from '../../types/cluster';

type Props = {
  detail: ReleaseDetail;
  canRollback: boolean;
  onClose: () => void;
  onRollback: (revision: number) => Promise<void>;
};

function revisionSeverity(status: string): Severity {
  if (status === 'failed') return 'critical';
  if (status.startsWith('pending')) return 'serious';
  if (status === 'deployed') return 'good';
  return 'warning';
}

/**
 * One release in full: what it is, what it went through, what the operator set, and
 * what it rendered. Rollback lives on the history rows, because "roll back" is always
 * "roll back to which one".
 */
export function ReleaseDetailPanel({ detail, canRollback, onClose, onRollback }: Props) {
  const [tab, setTab] = useState<DetailTab>('Overview');
  const [busy, setBusy] = useState(false);

  const rollback = async (revision: number) => {
    setBusy(true);
    try {
      await onRollback(revision);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="yaml-scrim" onClick={onClose}>
      <section
        className="helm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Release ${detail.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2 className="mono">{detail.name}</h2>
            <p>
              {detail.chart}-{detail.chart_version} · app {detail.app_version || '—'} · namespace {detail.namespace} ·
              revision {detail.revision}
            </p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="helm-tabs" role="tablist" aria-label="Release detail">
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

        <div className="helm-panel-body">
          {tab === 'Overview' && (
            <div className="helm-overview">
              <dl>
                <div><dt>Chart</dt><dd className="mono">{detail.chart}-{detail.chart_version}</dd></div>
                <div><dt>App version</dt><dd className="mono">{detail.app_version || '—'}</dd></div>
                <div><dt>First deployed</dt><dd>{formatDeployedAt(detail.first_deployed)}</dd></div>
                <div><dt>Last deployed</dt><dd>{formatDeployedAt(detail.last_deployed)}</dd></div>
                <div><dt>Last operation</dt><dd>{detail.description || '—'}</dd></div>
              </dl>
              {detail.notes ? (
                <>
                  <h3>Chart notes</h3>
                  <pre className="helm-pre">{detail.notes}</pre>
                </>
              ) : (
                <p className="viz-dim">This chart left no notes.</p>
              )}
            </div>
          )}

          {tab === 'History' && (
            <table className="viz-table">
              <thead>
                <tr><th>Revision</th><th>State</th><th>Chart</th><th>What happened</th><th>When</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {detail.history.map((entry) => (
                  <tr key={entry.revision}>
                    <td className="mono">
                      {entry.revision}
                      {entry.revision === detail.revision && <span className="cfg-tag">current</span>}
                    </td>
                    <td><SeverityBadge severity={revisionSeverity(entry.status)} label={entry.status} /></td>
                    <td className="mono viz-dim">{entry.chart_version || '—'}</td>
                    <td className="helm-description">{entry.description || '—'}</td>
                    <td>{entry.updated}</td>
                    <td>
                      {entry.revision !== detail.revision && (
                        <button
                          type="button"
                          className="viz-toggle"
                          disabled={!canRollback || busy}
                          title={
                            canRollback
                              ? `Run helm rollback to revision ${entry.revision}`
                              : 'The helm CLI is not on PATH.'
                          }
                          onClick={() => void rollback(entry.revision)}
                        >
                          <RotateCcw size={13} aria-hidden /> Roll back to this
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'Values' && (
            <>
              <p className="viz-dim helm-values-note">
                <History size={13} aria-hidden />
                Only the values set for this release. Chart defaults are not repeated here.
              </p>
              <pre className="helm-pre mono">{detail.values_yaml}</pre>
            </>
          )}

          {tab === 'Manifest' && (
            <pre className="helm-pre mono">{detail.manifest || '# This revision rendered an empty manifest.'}</pre>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
