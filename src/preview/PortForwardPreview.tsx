import { PortForwardPanel } from '../components/portforward/PortForwardPanel';

/** The port-forward panel with three live forwards, one of them on a TLS port. */
export function PortForwardPreview() {
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Port forward</h1>
          <p>Tunnels open from this machine to <b>checkout-api-7d9f8b6c4d-5kx2m</b></p>
        </div>
      </div>
      <div className="detail">
        <PortForwardPanel
          context="prod-shark"
          namespace="payments"
          podName="checkout-api-7d9f8b6c4d-5kx2m"
          canForward
          notify={(text, detail) => console.log('[toast]', text, detail)}
        />
      </div>
    </>
  );
}
