import { createRoot } from 'react-dom/client';
import { ClusterOverviewPage } from '../components/cluster/ClusterOverviewPage';
import { awsFixture, azureFixture } from './fixture';
import '../styles.css';
import '../cluster-overview.css';

/**
 * Renders the cluster overview against a fixture so the visual layer can be
 * reviewed and screenshotted without a live cluster. Not part of the app bundle.
 *
 * Pass ?provider=aks to review the path with no cloud enrichment and no metrics.
 */
const provider = new URLSearchParams(window.location.search).get('provider');
const fixture = provider === 'aks' ? azureFixture : awsFixture;

createRoot(document.getElementById('root')!).render(
  <div className="app" style={{ height: 'auto', overflow: 'visible' }}>
    <main className="main" style={{ overflow: 'visible' }}>
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
    </main>
  </div>,
);
