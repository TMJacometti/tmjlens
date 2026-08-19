import { createRoot } from 'react-dom/client';
import { ClusterOverviewPage } from '../components/cluster/ClusterOverviewPage';
import { ActionMenuPreview } from './ActionMenuPreview';
import { SettingsPreview } from './SettingsPreview';
import { ReportPreview } from './ReportPreview';
import { WorkloadsPreview } from './WorkloadsPreview';
import { NetworkPreview } from './NetworkPreview';
import { LogsPreview } from './LogsPreview';
import { PalettePreview } from './PalettePreview';
import { PortForwardPreview } from './PortForwardPreview';
import { VeleroPreview } from './VeleroPreview';
import { ConfigurationPreview } from './ConfigurationPreview';
import { installTauriStub } from './tauri-stub';
import { awsFixture, azureFixture } from './fixture';
import '../styles.css';
import '../cluster-overview.css';

/**
 * Renders app surfaces against fixtures so the visual layer can be reviewed and
 * screenshotted without a live cluster. Not part of the app bundle.
 *
 *   ?provider=aks   cluster overview with no cloud enrichment and no metrics
 *   ?view=actions   row action menu inside a clipping panel
 *   ?view=settings  settings panel over a stand-in shell
 *   ?view=report    the generated executive PDF, rendered inline
 *   ?view=workloads the modernised workloads screen with a stuck rollout
 *   ?view=network   services, endpoints, ingresses, classes and policies
 *   ?view=logs      the streaming log viewer, fed by synthetic batches
 *   ?view=palette   the command palette with cluster search
 *   ?view=forward   the port-forward panel with live tunnels
 */

// The preview runs in a plain browser, where the Tauri IPC bridge does not exist.
installTauriStub();

const params = new URLSearchParams(window.location.search);
const fixture = params.get('provider') === 'aks' ? azureFixture : awsFixture;
const view = params.get('view');
const root = createRoot(document.getElementById('root')!);

// Settings brings its own shell, so it renders without the page wrapper.
if (view === 'settings') {
  root.render(<SettingsPreview />);
} else if (view === 'report') {
  root.render(<ReportPreview data={fixture} environment="production" />);
} else {
  root.render(
    <div className="app" style={{ height: 'auto', overflow: 'visible' }}>
      <main className="main" style={{ overflow: 'visible' }}>
        {view === 'config' ? (
          <ConfigurationPreview />
        ) : view === 'velero' || view === 'velero-absent' || view === 'velero-expired' ? (
          <VeleroPreview installed={view === 'velero'} expired={view === 'velero-expired'} />
        ) : view === 'forward' ? (
          <PortForwardPreview />
        ) : view === 'palette' ? (
          <PalettePreview />
        ) : view === 'logs' ? (
          <LogsPreview />
        ) : view === 'network' ? (
          <NetworkPreview />
        ) : view === 'workloads' ? (
          <WorkloadsPreview />
        ) : view === 'actions' ? (
          <>
            <div className="title-row">
              <div>
                <h1>Workloads</h1>
                <p>Row action menu inside a clipping panel</p>
              </div>
            </div>
            <ActionMenuPreview />
          </>
        ) : (
          <>
            <div className="breadcrumbs">Cluster / {fixture.context} / Overview</div>
            <div className="title-row">
              <div>
                <h1>Cluster Overview</h1>
                <p>Cluster health, capacity, and node operations</p>
              </div>
            </div>
            <ClusterOverviewPage
              data={fixture}
              loading={false}
              error=""
              capabilities={{ cordon: true, drain: true, delete: false }}
              onRefresh={() => undefined}
              onNodeAction={() => undefined}
              onGenerateReport={() => undefined}
              generatingReport={false}
            />
          </>
        )}
      </main>
    </div>,
  );
}
