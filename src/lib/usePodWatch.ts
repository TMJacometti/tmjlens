import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PodRow } from '../types/workloads';

type PodWatchEvent =
  | { watch_id: string; change: 'reset'; pods: PodRow[] }
  | { watch_id: string; change: 'applied'; pod: PodRow }
  | { watch_id: string; change: 'deleted'; name: string };

export type WatchState = {
  pods: PodRow[];
  live: boolean;
  /** Set when the watch ended for a reason the user should know about. */
  error: string;
};

/**
 * Keeps a namespace's pod list live.
 *
 * The list used to be a snapshot that only changed when something re-fetched it, so a
 * pod that died a second after loading stayed on screen looking healthy. This follows
 * the API server instead, and `live` says plainly whether what is on screen is being
 * kept current — a stale list that claims to be live is worse than an honest snapshot.
 */
export function usePodWatch(context: string, namespace: string, enabled: boolean): WatchState {
  const [pods, setPods] = useState<PodRow[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const watchId = useRef(`pods-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    if (!enabled || !context || !namespace) return;

    let cancelled = false;
    setError('');

    const subscriptions = [
      listen<PodWatchEvent>('pod-watch', (event) => {
        const payload = event.payload;
        if (payload.watch_id !== watchId) return;
        if (payload.change === 'reset') {
          // A relist replaces rather than merges, so pods that vanished while the
          // watch was down do not linger.
          setPods(payload.pods);
          setLive(true);
        } else if (payload.change === 'applied') {
          setPods((current) => {
            const index = current.findIndex((row) => row.name === payload.pod.name);
            if (index === -1) return [...current, payload.pod];
            const next = [...current];
            next[index] = payload.pod;
            return next;
          });
        } else {
          setPods((current) => current.filter((row) => row.name !== payload.name));
        }
      }),
      listen<{ watch_id: string; error?: string }>('pod-watch-closed', (event) => {
        if (event.payload.watch_id !== watchId) return;
        setLive(false);
        if (event.payload.error) setError(event.payload.error);
      }),
    ];

    void invoke('start_pod_watch', { context, namespace, watchId }).catch((cause) => {
      if (cancelled) return;
      setLive(false);
      setError(String(cause));
    });

    return () => {
      cancelled = true;
      setLive(false);
      void invoke('stop_pod_watch', { watchId }).catch(() => undefined);
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, [context, namespace, enabled, watchId]);

  return { pods, live, error };
}
