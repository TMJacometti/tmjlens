import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/transport';
import { CheckCircle2, FileCog, Info, Layers3, Lock, ShieldAlert, X } from 'lucide-react';
import { EnvironmentBadge } from './EnvironmentBadge';
import { ENVIRONMENTS, type AppSettings, type EnvironmentId, type KubeconfigView } from '../../types/settings';
import './settings.css';

type Tab = 'clusters' | 'kubeconfig' | 'about';

type Props = {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onKubeconfigChanged: () => void;
  onClose: () => void;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function SettingsPanel({ settings, onSettingsChange, onKubeconfigChanged, onClose, notify }: Props) {
  const [tab, setTab] = useState<Tab>('clusters');
  const [view, setView] = useState<KubeconfigView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const reload = async () => {
    try {
      setView(await invoke<KubeconfigView>('read_kubeconfig'));
      setError('');
    } catch (cause) {
      setError(String(cause));
    }
  };

  useEffect(() => {
    void reload();
  }, [settings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const assignEnvironment = async (context: string, environment: EnvironmentId) => {
    const next: AppSettings = {
      ...settings,
      context_environments: { ...settings.context_environments, [context]: environment },
    };
    try {
      await invoke('save_settings', { settings: next });
      onSettingsChange(next);
    } catch (cause) {
      notify('Could not save the environment', String(cause), 'bad');
    }
  };

  const switchContext = async (name: string) => {
    setBusy(name);
    try {
      await invoke('set_current_context', { name });
      await reload();
      onKubeconfigChanged();
      notify('Current context changed', `kubectl now uses ${name}`, 'good');
    } catch (cause) {
      notify('Could not change the current context', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  const changeNamespace = async (context: string, current?: string) => {
    const value = window.prompt(`Default namespace for ${context}\n\nLeave empty to clear it.`, current ?? '');
    if (value === null) return;
    setBusy(context);
    try {
      await invoke('set_context_namespace', { context, namespace: value.trim() || null });
      await reload();
      onKubeconfigChanged();
      notify('Default namespace updated', `${context} → ${value.trim() || 'none'}`, 'good');
    } catch (cause) {
      notify('Could not update the namespace', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  return createPortal(
    <div className="settings-scrim" onClick={onClose}>
      <aside
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="viz-icon" onClick={onClose} aria-label="Close settings">
            <X size={16} />
          </button>
        </header>

        <nav className="settings-tabs">
          <button type="button" className={tab === 'clusters' ? 'is-active' : ''} onClick={() => setTab('clusters')}>
            <Layers3 size={14} /> Clusters
          </button>
          <button type="button" className={tab === 'kubeconfig' ? 'is-active' : ''} onClick={() => setTab('kubeconfig')}>
            <FileCog size={14} /> Kubeconfig
          </button>
          <button type="button" className={tab === 'about' ? 'is-active' : ''} onClick={() => setTab('about')}>
            <Info size={14} /> About
          </button>
        </nav>

        <div className="settings-body">
          {error && <div className="settings-error">{error}</div>}

          {tab === 'clusters' && (
            <ClustersTab
              view={view}
              settings={settings}
              onAssign={assignEnvironment}
              onToggleConfirm={async (value) => {
                const next = { ...settings, confirm_destructive_in_production: value };
                try {
                  await invoke('save_settings', { settings: next });
                  onSettingsChange(next);
                } catch (cause) {
                  notify('Could not save the setting', String(cause), 'bad');
                }
              }}
            />
          )}

          {tab === 'kubeconfig' && (
            <KubeconfigTab view={view} busy={busy} onSwitch={switchContext} onNamespace={changeNamespace} />
          )}

          {tab === 'about' && <AboutTab />}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function ClustersTab({
  view,
  settings,
  onAssign,
  onToggleConfirm,
}: {
  view: KubeconfigView | null;
  settings: AppSettings;
  onAssign: (context: string, environment: EnvironmentId) => void;
  onToggleConfirm: (value: boolean) => void;
}) {
  if (!view) return <p className="settings-muted">Reading kubeconfig…</p>;

  return (
    <>
      <p className="settings-lead">
        Classify each context so its blast radius is visible before you act. The label is stored locally in tmjLens
        and never written to the cluster or the kubeconfig.
      </p>

      <ul className="settings-contexts">
        {view.contexts.map((context) => (
          <li key={context.name}>
            <div className="settings-context-head">
              <span className="mono">{context.name}</span>
              {context.current && <span className="settings-current">current</span>}
              <EnvironmentBadge environment={context.environment} />
            </div>
            <div className="settings-env-picker" role="group" aria-label={`Environment for ${context.name}`}>
              {ENVIRONMENTS.map((environment) => (
                <button
                  key={environment.id}
                  type="button"
                  className={context.environment === environment.id ? 'is-selected' : ''}
                  title={environment.description}
                  onClick={() => onAssign(context.name, environment.id)}
                >
                  {environment.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.confirm_destructive_in_production}
          onChange={(event) => onToggleConfirm(event.target.checked)}
        />
        <span>
          <strong>Type the cluster name to confirm destructive actions in production</strong>
          <small>
            Deleting a pod or draining a node in a context marked Production asks you to type its name first. Other
            environments keep the normal confirmation.
          </small>
        </span>
      </label>
    </>
  );
}

function KubeconfigTab({
  view,
  busy,
  onSwitch,
  onNamespace,
}: {
  view: KubeconfigView | null;
  busy: string;
  onSwitch: (name: string) => void;
  onNamespace: (context: string, current?: string) => void;
}) {
  if (!view) return <p className="settings-muted">Reading kubeconfig…</p>;

  return (
    <>
      <dl className="settings-facts">
        <div>
          <dt>File</dt>
          <dd className="mono">{view.path ?? 'not found'}</dd>
        </div>
        <div>
          <dt>Current context</dt>
          <dd className="mono">{view.current_context ?? 'none'}</dd>
        </div>
      </dl>

      {!view.writable && (
        <div className="settings-notice">
          <Lock size={15} aria-hidden />
          <div>
            <strong>Read-only</strong>
            <p>{view.read_only_reason}</p>
          </div>
        </div>
      )}

      <p className="settings-lead">
        These edits change the same file <code>kubectl</code> reads. A copy is written to
        <code> config.tmjlens.bak</code> before every change, and credentials are never touched — only the current
        context and the default namespace.
      </p>

      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Context</th>
              <th>Cluster</th>
              <th>Auth</th>
              <th>Namespace</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.contexts.map((context) => (
              <tr key={context.name}>
                <td className="mono">
                  {context.name}
                  {context.current && <span className="settings-current">current</span>}
                </td>
                <td title={context.server}>{context.cluster}</td>
                <td>{context.auth_method}</td>
                <td>{context.namespace ?? <span className="viz-dim">default</span>}</td>
                <td className="settings-row-actions">
                  <button
                    type="button"
                    className="viz-toggle"
                    disabled={!view.writable || context.current || busy === context.name}
                    onClick={() => onSwitch(context.name)}
                  >
                    {context.current ? 'In use' : 'Use'}
                  </button>
                  <button
                    type="button"
                    className="viz-toggle"
                    disabled={!view.writable || busy === context.name}
                    onClick={() => onNamespace(context.name, context.namespace)}
                  >
                    Namespace
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AboutTab() {
  return (
    <>
      <div className="settings-about">
        <span className="settings-shark">🦈</span>
        <div>
          <h3>tmjLens</h3>
          <p>A Kubernetes operations console that tells you what is wrong, not just what exists.</p>
        </div>
      </div>

      <dl className="settings-facts">
        <div>
          <dt>Version</dt>
          <dd>0.1.0</dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>GNU AGPL v3.0</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd className="mono">github.com/TMJacometti/tmjlens</dd>
        </div>
      </dl>

      <div className="settings-notice">
        <ShieldAlert size={15} aria-hidden />
        <div>
          <strong>How tmjLens handles your credentials</strong>
          <p>
            It stores none of them. Cluster access uses your existing kubeconfig and your cloud provider's own
            credential chain, and Kubernetes RBAC stays the only authority over what you may do. The interface itself
            holds no filesystem permission.
          </p>
        </div>
      </div>

      <div className="settings-notice">
        <CheckCircle2 size={15} aria-hidden />
        <div>
          <strong>Free software</strong>
          <p>
            tmjLens is licensed under the GNU Affero General Public License v3.0. You may use, study, modify and share
            it; derivative work — including work offered to others over a network — must remain under the same licence.
          </p>
        </div>
      </div>
    </>
  );
}
