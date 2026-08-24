import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PodMetricsSnapshot, PodUsageRow } from '../types/metrics';

export type PodMetricsState = {
  byPod: Record<string, PodUsageRow>;
  available: boolean;
  /** Why usage is missing, when it is. */
  reason: string;
};

/**
 * Polls live usage for a namespace while the screen that shows it is open.
 *
 * Ten seconds, deliberately: metrics-server refreshes its samples on its own cadence
 * (15s scrape by default), so polling faster buys nothing — the sample timestamp on
 * each row is what says how fresh the numbers really are. Polling stops the moment
 * `enabled` drops, so leaving the screen stops the traffic.
 */
export function usePodMetrics(context: string, namespace: string, enabled: boolean): PodMetricsState {
  const [snapshot, setSnapshot] = useState<PodMetricsSnapshot | null>(null);
  const [reason, setReason] = useState('');
  // A late response from a previous namespace must not overwrite the current one.
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled || !context || !namespace) return;
    const mine = ++generation.current;

    const read = async () => {
      try {
        const next = await invoke<PodMetricsSnapshot>('get_pod_metrics', { context, namespace });
        if (generation.current !== mine) return;
        setSnapshot(next);
        setReason(next.reason ?? '');
      } catch (cause) {
        if (generation.current !== mine) return;
        // A failed poll keeps the last good numbers on screen; the sample age keeps
        // climbing, which is the honest signal that they are getting stale.
        setReason(String(cause));
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), 10_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [context, namespace, enabled]);

  const byPod = useMemo(() => {
    const map: Record<string, PodUsageRow> = {};
    for (const row of snapshot?.pods ?? []) map[row.name] = row;
    return map;
  }, [snapshot]);

  return { byPod, available: snapshot?.available ?? false, reason };
}
