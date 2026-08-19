import { useState } from 'react';
import { ChevronDown, GitBranch, Layers3, Search, Settings } from 'lucide-react';
import { SettingsPanel } from '../components/settings/SettingsPanel';
import { EnvironmentBadge, EnvironmentStripe } from '../components/settings/EnvironmentBadge';
import type { AppSettings, EnvironmentId } from '../types/settings';

/**
 * Renders the settings surface over a stand-in shell, so the environment stripe and
 * badge can be reviewed in the position they actually occupy. The Tauri IPC is
 * stubbed in preview/main.tsx — nothing here reaches a real kubeconfig.
 */
export function SettingsPreview() {
  const [settings, setSettings] = useState<AppSettings>({
    context_environments: {
      'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark': 'production',
      'aks-hml-shark': 'staging',
      'minikube': 'development',
    },
    confirm_destructive_in_production: true,
  });
  const [open, setOpen] = useState(true);

  const context = 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark';
  const environment: EnvironmentId = settings.context_environments[context] ?? 'unset';

  return (
    <div className="app" style={{ height: '100vh' }}>
      <EnvironmentStripe environment={environment} />
      <header className="topbar">
        <div className="brand">
          <span className="shark">🦈</span> tmjLens
        </div>
        <label className="selector">
          <GitBranch size={15} />
          <select value={context} onChange={() => undefined}>
            <option value={context}>{context}</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <EnvironmentBadge environment={environment} />
        <label className="selector">
          <Layers3 size={15} />
          <span>ns:</span>
          <select value="payments" onChange={() => undefined}>
            <option value="payments">payments</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <div className="spacer" />
        <button className="icon-btn" title="Search">
          <Search size={17} />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setOpen(true)}>
          <Settings size={17} />
        </button>
      </header>

      {open && (
        <SettingsPanel
          settings={settings}
          onSettingsChange={setSettings}
          onKubeconfigChanged={() => undefined}
          onClose={() => setOpen(false)}
          notify={(text, detail) => console.log('[toast]', text, detail)}
        />
      )}
    </div>
  );
}
