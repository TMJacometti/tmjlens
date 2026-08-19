import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Copy, ExternalLink, Plug, ShieldAlert, Square } from 'lucide-react';
import './portforward.css';

export type PodPort = {
  container: string;
  name?: string;
  port: number;
  protocol: string;
};

export type ActiveForward = {
  id: string;
  namespace: string;
  pod: string;
  remote_port: number;
  local_port: number;
  local_address: string;
  connections: number;
};

type Props = {
  context: string;
  namespace: string;
  podName: string;
  canForward: boolean;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function PortForwardPanel({ context, namespace, podName, canForward, notify }: Props) {
  const [ports, setPorts] = useState<PodPort[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [localPort, setLocalPort] = useState('');
  const [forwards, setForwards] = useState<ActiveForward[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => invoke<ActiveForward[]>('list_port_forwards').then(setForwards).catch(() => undefined);

  useEffect(() => {
    void invoke<PodPort[]>('list_pod_ports', { context, namespace, podName })
      .then((found) => {
        setPorts(found);
        setSelected(found[0]?.port ?? null);
        setError('');
      })
      .catch((cause) => setError(String(cause)));
    void refresh();
  }, [context, namespace, podName]);

  useEffect(() => {
    const subscription = listen<{ id: string; connections: number; error?: string; closed: boolean }>(
      'port-forward',
      (event) => {
        if (event.payload.error) setError(event.payload.error);
        void refresh();
      },
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  const start = async () => {
    if (selected === null) return;
    setBusy(true);
    setError('');
    try {
      const requested = localPort.trim() ? Number(localPort.trim()) : undefined;
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
        setError('A local port must be a whole number between 1 and 65535.');
        return;
      }
      const forward = await invoke<ActiveForward>('start_port_forward', {
        context,
        namespace,
        podName,
        remotePort: selected,
        localPort: requested ?? null,
        forwardId: `pf-${podName}-${selected}-${Date.now()}`,
      });
      notify('Port forward open', `${forward.local_address}:${forward.local_port} → ${podName}:${forward.remote_port}`, 'good');
      setLocalPort('');
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    await invoke('stop_port_forward', { forwardId: id }).catch(() => undefined);
    await refresh();
  };

  const mine = forwards.filter((forward) => forward.pod === podName);
  const others = forwards.filter((forward) => forward.pod !== podName);

  return (
    <div className="pf">
      <p className="wl-lead">
        A forward opens a port on <strong>this machine only</strong>. It binds <code>127.0.0.1</code>, never every
        interface, so nothing else on your network reaches the pod through it. It lasts until you stop it or close the
        app.
      </p>

      {error && <div className="pf-error">{error}</div>}

      {!canForward ? (
        <div className="settings-notice">
          <ShieldAlert size={15} aria-hidden />
          <div>
            <strong>Kubernetes denied port-forward</strong>
            <p>
              This identity cannot <code>create pods/portforward</code> in {namespace}.
            </p>
          </div>
        </div>
      ) : (
        <div className="pf-form">
          <label>
            <span>Pod port</span>
            <select
              value={selected ?? ''}
              onChange={(event) => setSelected(Number(event.target.value))}
              disabled={ports.length === 0}
            >
              {ports.length === 0 ? (
                <option value="">This pod declares no TCP ports</option>
              ) : (
                ports.map((port) => (
                  <option key={`${port.container}-${port.port}`} value={port.port}>
                    {port.port}
                    {port.name ? ` (${port.name})` : ''} · {port.container}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            <span>Local port</span>
            <input
              value={localPort}
              onChange={(event) => setLocalPort(event.target.value)}
              placeholder="auto"
              inputMode="numeric"
              aria-label="Local port, leave empty to choose automatically"
            />
          </label>

          <button type="button" className="viz-primary" onClick={() => void start()} disabled={busy || selected === null}>
            <Plug size={14} aria-hidden />
            {busy ? 'Opening…' : 'Forward'}
          </button>
        </div>
      )}

      <ForwardList title="This pod" forwards={mine} onStop={stop} notify={notify} empty="No forward is open for this pod." />
      {others.length > 0 && (
        <ForwardList title="Elsewhere in the app" forwards={others} onStop={stop} notify={notify} empty="" />
      )}
    </div>
  );
}

function ForwardList({
  title,
  forwards,
  onStop,
  notify,
  empty,
}: {
  title: string;
  forwards: ActiveForward[];
  onStop: (id: string) => void;
  notify: Props['notify'];
  empty: string;
}) {
  return (
    <div className="pf-list">
      <h4>{title}</h4>
      {forwards.length === 0 ? (
        <p className="viz-dim">{empty}</p>
      ) : (
        <ul>
          {forwards.map((forward) => {
            const scheme = [443, 8443, 9443].includes(forward.remote_port) ? 'https' : 'http';
            const address = `${forward.local_address}:${forward.local_port}`;
            const url = `${scheme}://${address}`;
            return (
              <li key={forward.id}>
                <code className="pf-address">{url}</code>
                <span className="pf-arrow">→</span>
                <span className="mono pf-target">
                  {forward.pod}:{forward.remote_port}
                </span>
                <span className="viz-dim pf-conns">
                  {forward.connections} connection{forward.connections === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="viz-toggle"
                  title={`Open ${url} in your default browser`}
                  onClick={() => {
                    void invoke<string>('open_forward_in_browser', { forwardId: forward.id })
                      .then((opened) => notify('Opened in your browser', opened, 'good'))
                      .catch((cause) => notify('Could not open the browser', String(cause), 'bad'));
                  }}
                >
                  <ExternalLink size={13} aria-hidden /> Open in browser
                </button>
                <button
                  type="button"
                  className="viz-toggle"
                  onClick={() => {
                    void navigator.clipboard?.writeText(url);
                    notify('Address copied', url, 'good');
                  }}
                >
                  <Copy size={13} aria-hidden /> Copy
                </button>
                <button type="button" className="viz-toggle viz-danger" onClick={() => onStop(forward.id)}>
                  <Square size={13} aria-hidden /> Stop
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
