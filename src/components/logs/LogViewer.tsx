import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasBridge, invoke, listen } from '../../lib/transport';
import { Download, Pause, Play, Search } from 'lucide-react';
import './logs.css';

/**
 * The viewer holds at most this many lines. A chatty container produces more than a
 * browser can keep in a DOM node, and an unbounded buffer turns a long follow into a
 * memory leak. The count that was dropped is stated rather than hidden.
 */
const MAX_LINES = 5000;

type Props = {
  context: string;
  namespace: string;
  podName: string;
  containers: string[];
  selectedContainer: string;
  onSelectContainer: (name: string) => void;
  onExport: () => void;
};

export function LogViewer({
  context,
  namespace,
  podName,
  containers,
  selectedContainer,
  onSelectContainer,
  onExport,
}: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [dropped, setDropped] = useState(0);
  const [following, setFollowing] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [tail, setTail] = useState(200);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // One id per mounted viewer, so a stream can be stopped precisely.
  const streamId = useRef(`log-${Math.random().toString(36).slice(2)}-${Date.now()}`).current;
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Web streaming: the SSE connection and the lines it delivered since the
  // last flush. Appending per event would re-render once per log line; the
  // buffer is drained on a short interval instead.
  const source = useRef<EventSource | null>(null);
  const pending = useRef<string[]>([]);

  const stop = useCallback(async () => {
    if (source.current) {
      source.current.close();
      source.current = null;
    }
    if (hasBridge()) await invoke('stop_log_stream', { streamId }).catch(() => undefined);
  }, [streamId]);

  // Reading a fixed window, rather than following. Cheap and always available.
  const fetchOnce = useCallback(
    async (allLines = false) => {
      setError('');
      setStatus('reading…');
      try {
        const body = await invoke<string>('get_pod_logs', {
          context,
          namespace,
          podName,
          container: selectedContainer || undefined,
          tailLines: allLines ? null : tail,
          previous,
        });
        const next = body ? body.split('\n') : [];
        setLines(next);
        setDropped(0);
        setStatus(next.length === 0 ? 'no output' : `${next.length} lines`);
      } catch (cause) {
        setError(String(cause));
        setStatus('');
      }
    },
    [context, namespace, podName, selectedContainer, tail, previous],
  );

  const startFollow = useCallback(async () => {
    setError('');
    setLines([]);
    setDropped(0);
    setStatus('connecting…');
    if (!hasBridge()) {
      // Web build: the server follows the pod and relays over SSE. No
      // auto-reconnect — a resumed stream would replay the tail as duplicates.
      const params = new URLSearchParams({ namespace, pod: podName, tail: String(tail) });
      if (selectedContainer) params.set('container', selectedContainer);
      if (timestamps) params.set('timestamps', 'true');
      if (previous) params.set('previous', 'true');
      const stream = new EventSource(`/api/logs/stream?${params.toString()}`);
      source.current = stream;
      stream.onopen = () => {
        setFollowing(true);
        setStatus('following');
      };
      stream.onmessage = (event) => {
        pending.current.push(event.data as string);
      };
      stream.addEventListener('closed', (event) => {
        const reason = (event as MessageEvent).data as string;
        stream.close();
        source.current = null;
        setFollowing(false);
        setStatus(reason ? '' : 'stream ended');
        if (reason) setError(reason);
      });
      stream.onerror = () => {
        if (!source.current) return;
        stream.close();
        source.current = null;
        setFollowing(false);
        setStatus('');
        setError('The log stream was interrupted.');
      };
      return;
    }
    try {
      await invoke('start_log_stream', {
        context,
        namespace,
        podName,
        container: selectedContainer || undefined,
        tailLines: tail,
        timestamps,
        previous,
        streamId,
      });
      setFollowing(true);
      setStatus('following');
    } catch (cause) {
      setError(String(cause));
      setFollowing(false);
      setStatus('');
    }
  }, [context, namespace, podName, selectedContainer, tail, timestamps, previous, streamId]);

  // Drains the SSE buffer on a heartbeat, enforcing the same line cap as the
  // desktop stream so a chatty container cannot grow the DOM without bound.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((current) => {
        const next = [...current, ...batch];
        if (next.length <= MAX_LINES) return next;
        const overflow = next.length - MAX_LINES;
        setDropped((count) => count + overflow);
        return next.slice(overflow);
      });
    }, 150);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const batch = listen<{ stream_id: string; lines: string[] }>('pod-log', (event) => {
      if (event.payload.stream_id !== streamId) return;
      setLines((current) => {
        const next = [...current, ...event.payload.lines];
        if (next.length <= MAX_LINES) return next;
        const overflow = next.length - MAX_LINES;
        setDropped((count) => count + overflow);
        return next.slice(overflow);
      });
    });

    const closed = listen<{ stream_id: string; error?: string }>('pod-log-closed', (event) => {
      if (event.payload.stream_id !== streamId) return;
      setFollowing(false);
      setStatus(event.payload.error ? '' : 'stream ended');
      if (event.payload.error) setError(event.payload.error);
    });

    return () => {
      void batch.then((unlisten) => unlisten());
      void closed.then((unlisten) => unlisten());
    };
  }, [streamId]);

  // Stop the stream when the viewer goes away or its target changes; a stream left
  // running would keep charging the API server for output nobody reads.
  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  useEffect(() => {
    setFollowing(false);
    void stop();
    void fetchOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podName, selectedContainer, previous]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  }, [lines, filter]);

  const toggleFollow = () => {
    if (following) {
      void stop();
      setFollowing(false);
      setStatus('paused');
    } else {
      void startFollow();
    }
  };

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <select
          value={selectedContainer}
          onChange={(event) => onSelectContainer(event.target.value)}
          aria-label="Container"
        >
          {containers.length === 0 ? (
            <option value="">No containers</option>
          ) : (
            containers.map((container) => (
              <option key={container} value={container}>
                {container}
              </option>
            ))
          )}
        </select>

        <button type="button" className={following ? 'viz-primary' : 'viz-toggle'} onClick={toggleFollow}>
          {following ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          {following ? 'Pause' : 'Follow'}
        </button>

        <button type="button" className="viz-toggle" onClick={() => void fetchOnce()} disabled={following}>
          Reload
        </button>

        <label className="log-check">
          <input type="checkbox" checked={timestamps} onChange={(event) => setTimestamps(event.target.checked)} />
          Timestamps
        </label>

        <label className="log-check" title="Read the log of the previous container instance — what a crash-looping container left behind.">
          <input type="checkbox" checked={previous} onChange={(event) => setPrevious(event.target.checked)} />
          Previous
        </label>

        <label className="log-check">
          Tail
          <select value={tail} onChange={(event) => setTail(Number(event.target.value))} disabled={following}>
            {[100, 200, 500, 1000, 5000].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="log-search">
          <Search size={13} aria-hidden />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter lines…"
            aria-label="Filter log lines"
          />
        </label>

        <span className="log-spacer" />
        <span className="log-status">{status}</span>
        <button type="button" className="viz-toggle" onClick={onExport}>
          <Download size={13} aria-hidden /> Export
        </button>
      </div>

      {error && <div className="log-error">{error}</div>}

      {(dropped > 0 || (filter && visible.length !== lines.length)) && (
        <div className="log-note">
          {dropped > 0 && `${dropped.toLocaleString()} earlier lines dropped to stay within ${MAX_LINES.toLocaleString()}. `}
          {filter && `${visible.length} of ${lines.length} lines match.`}
        </div>
      )}

      <div
        className="log-body"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          // Following only auto-scrolls while the reader is at the bottom; scrolling
          // up to read something must not be yanked away by the next batch.
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {visible.length === 0 ? (
          <div className="viz-empty">
            {previous
              ? 'No previous instance for this container — it has not restarted.'
              : 'No output yet. Press Follow to stream, or Reload to read the current tail.'}
          </div>
        ) : (
          <pre>{visible.join('\n')}</pre>
        )}
      </div>
    </div>
  );
}
