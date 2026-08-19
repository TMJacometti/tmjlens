import { useState } from 'react';
import { LogViewer } from '../components/logs/LogViewer';

/**
 * The streaming log viewer against the preview stub, which emits synthetic batches on
 * the same Tauri event the real stream uses. Follow, pause, filter and the drop notice
 * are all exercisable here without a cluster.
 */
export function LogsPreview() {
  const [container, setContainer] = useState('checkout-api');

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Pod logs</h1>
          <p>
            Streaming viewer for <b>checkout-api-7d9f8b6c4d-5kx2m</b>
          </p>
        </div>
      </div>
      <div className="detail">
        <LogViewer
          context="prod-shark"
          namespace="payments"
          podName="checkout-api-7d9f8b6c4d-5kx2m"
          containers={[container, 'envoy-sidecar']}
          selectedContainer={container}
          onSelectContainer={setContainer}
          onExport={() => undefined}
        />
      </div>
    </>
  );
}
