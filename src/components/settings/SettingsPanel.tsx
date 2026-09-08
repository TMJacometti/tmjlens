import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/transport';
import { CheckCircle2, Info, Layers3, ShieldAlert, X } from 'lucide-react';
import { EnvironmentBadge } from './EnvironmentBadge';
import { ENVIRONMENTS, type AppSettings, type EnvironmentId, type KubeconfigView } from '../../types/settings';
import './settings.css';

type Tab = 'clusters' | 'about';

type Props = {
  settings: AppSettings;
  /** Web instances are configured at install; the cluster tab is a fact sheet. */
  readOnly?: boolean;
  onSettingsChange: (settings: AppSettings) => void;
  onClose: () => void;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function SettingsPanel({ settings, readOnly = false, onSettingsChange, onClose, notify }: Props) {
  const [tab, setTab] = useState<Tab>('clusters');
  const [view, setView] = useState<KubeconfigView | null>(null);
  const [error, setError] = useState('');

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
              readOnly={readOnly}
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
  readOnly,
  onAssign,
  onToggleConfirm,
}: {
  view: KubeconfigView | null;
  settings: AppSettings;
  readOnly: boolean;
  onAssign: (context: string, environment: EnvironmentId) => void;
  onToggleConfirm: (value: boolean) => void;
}) {
  if (!view) return <p className="settings-muted">Reading kubeconfig…</p>;

  return (
    <>
      <p className="settings-lead">
        {readOnly
          ? 'This instance\'s environment is set at install and cannot be changed here. Destructive actions in Production still ask for the cluster name.'
          : 'Classify the cluster so its blast radius is visible before you act. The label is stored by tmjLens for this instance and never written to the cluster itself.'}
      </p>

      <ul className="settings-contexts">
        {view.contexts.map((context) => (
          <li key={context.name}>
            <div className="settings-context-head">
              <span className="mono">{context.name}</span>
              {context.current && <span className="settings-current">current</span>}
              <EnvironmentBadge environment={context.environment} />
            </div>
            {readOnly ? (
              <p className="settings-muted">
                {view.read_only_reason ?? 'Set with TMJLENS_ENVIRONMENT when the instance was installed.'}
              </p>
            ) : (
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
            )}
          </li>
        ))}
      </ul>

      {!readOnly && (
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
      )}
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
            It stores none of them. You sign in with your company's identity provider; what you may do here is
            decided by the profiles an admin granted you, every sensitive action is recorded under your own name,
            and the instance's ServiceAccount is capped by Kubernetes RBAC.
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
