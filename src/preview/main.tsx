import { createRoot } from 'react-dom/client';
import { ClusterOverviewPage } from '../components/cluster/ClusterOverviewPage';
import { ActionMenuPreview } from './ActionMenuPreview';
import { awsFixture, azureFixture } from './fixture';
import '../styles.css';
import '../cluster-overview.css';

/**
 * Renders the cluster overview against a fixture so the visual layer can be
 * reviewed and screenshotted without a live cluster. Not part of the app bundle.
 *
 * Pass ?provider=aks to review the path with no cloud enrichment and no metrics.
 */
const params = new URLSearchParams(window.location.search);
const fixture = params.get('provider') === 'aks' ? azureFixture : awsFixture;
const view = params.get('view');

createRoot(document.getElementById('root')!).render(
  <div className="app" style={{ height: 'auto', overflow: 'visible' }}>
    <main className="main" style={{ overflow: 'visible' }}>
      {view === 'actions' ? (
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
          />
        </>
      )}
    </main>
  </div>,
);
