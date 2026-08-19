import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ShieldAlert, Square, TerminalSquare } from 'lucide-react';
import { stripAnsi } from '../../lib/ansi';
import './exec.css';

const SHELLS = ['/bin/bash', '/bin/sh', '/busybox/sh'];
/** Bounded like the log viewer: a terminal that prints forever must not grow forever. */
const MAX_CHARS = 200_000;

type Props = {
  context: string;
  namespace: string;
  podName: string;
  containers: string[];
  canExec: boolean;
  environmentWarning?: string;
};

/**
 * An interactive shell in a container.
 *
 * The output is rendered as plain text with ANSI escapes stripped rather than through
 * a full terminal emulator. A real emulator is a large dependency to load into a
 * window that also talks to a cluster, and the escapes it would render are exactly the
 * kind of thing a compromised container would use to redraw the screen. Programs that
 * need a full TTY — vim, htop — are the acknowledged cost of that trade.
 */
export function ExecTerminal({ context, namespace, podName, containers, canExec, environmentWarning }: Props) {
  const [container, setContainer] = useState(containers[0] ?? '');
  const [shell, setShell] = useState(SHELLS[1]);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [line, setLine] = useState('');
  const sessionId = useRef(`exec-${Math.random().toString(36).slice(2)}`).current;
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const subscriptions = [
      listen<{ session_id: string; chunk: string }>('pod-exec', (event) => {
        if (event.payload.session_id !== sessionId) return;
        setOutput((current) => {
          const next = current + stripAnsi(event.payload.chunk);
          return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next;
        });
      }),
      listen<{ session_id: string; error?: string }>('pod-exec-closed', (event) => {
        if (event.payload.session_id !== sessionId) return;
        setRunning(false);
        if (event.payload.error) setError(event.payload.error);
        else setOutput((current) => `${current}\n[session ended]\n`);
      }),
    ];
    return () => {
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, [sessionId]);

  useEffect(() => {
    return () => {
      void invoke('stop_exec_session', { sessionId }).catch(() => undefined);
    };
  }, [sessionId]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [output]);

  const open = async () => {
    setError('');
    setOutput('');
    try {
      await invoke('start_exec_session', {
        context,
        namespace,
        podName,
        container: container || undefined,
        shell,
        sessionId,
      });
      setRunning(true);
      input.current?.focus();
    } catch (cause) {
      setError(String(cause));
      setRunning(false);
    }
  };

  const close = async () => {
    await invoke('stop_exec_session', { sessionId }).catch(() => undefined);
    setRunning(false);
  };

  const send = async (data: string) => {
    try {
      await invoke('write_exec_session', { sessionId, data });
    } catch (cause) {
      setError(String(cause));
      setRunning(false);
    }
  };

  if (!canExec) {
    return (
      <div className="settings-notice exec-denied">
        <ShieldAlert size={15} aria-hidden />
        <div>
          <strong>Kubernetes denied exec</strong>
          <p>
            This identity cannot <code>create pods/exec</code> in {namespace}. The app does not offer a way around
            that.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="exec">
      {environmentWarning && (
        <div className="exec-warning">
          <ShieldAlert size={15} aria-hidden />
          <span>{environmentWarning}</span>
        </div>
      )}

      <div className="exec-toolbar">
        <select value={container} onChange={(event) => setContainer(event.target.value)} disabled={running} aria-label="Container">
          {containers.length === 0 ? <option value="">No containers</option> : containers.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>

        <select value={shell} onChange={(event) => setShell(event.target.value)} disabled={running} aria-label="Shell">
          {SHELLS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>

        {running ? (
          <button type="button" className="viz-toggle viz-danger" onClick={() => void close()}>
            <Square size={13} aria-hidden /> End session
          </button>
        ) : (
          <button type="button" className="viz-primary" onClick={() => void open()}>
            <TerminalSquare size={14} aria-hidden /> Open shell
          </button>
        )}

        <span className="log-spacer" />
        <span className="exec-status">{running ? 'connected' : 'not connected'}</span>
      </div>

      {error && <div className="exec-error">{error}</div>}

      <div className="exec-body" ref={scroller} onClick={() => input.current?.focus()}>
        <pre>{output || 'Open a shell to start. Output is plain text — a full TTY program such as vim will not render.'}</pre>
      </div>

      <form
        className="exec-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) return;
          setOutput((current) => `${current}$ ${line}\n`);
          void send(`${line}\n`);
          setLine('');
        }}
      >
        <span aria-hidden>$</span>
        <input
          ref={input}
          value={line}
          onChange={(event) => setLine(event.target.value)}
          disabled={!running}
          placeholder={running ? 'Type a command and press Enter' : 'Open a shell first'}
          aria-label="Command"
          onKeyDown={(event) => {
            // Ctrl+C reaches the container as the interrupt byte rather than copying.
            if (event.ctrlKey && event.key.toLowerCase() === 'c' && running) {
              event.preventDefault();
              void send('');
            }
          }}
        />
      </form>
    </div>
  );
}
