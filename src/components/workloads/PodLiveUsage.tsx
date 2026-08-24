import { useEffect, useState } from 'react';
import { Activity, ShieldAlert } from 'lucide-react';
import {
  cpuSeverity, describeSample, formatCpuMilli, formatMemoryBytes, memorySeverity, pctOf,
  type ContainerUsage, type PodUsageRow,
} from '../../types/metrics';
import type { Severity } from '../../types/cluster';

type Props = {
  usage: PodUsageRow | undefined;
  available: boolean;
  reason: string;
};

/**
 * Live usage for one pod, per container, against requests and limits.
 *
 * The meters only appear where a limit exists, because a bar needs a real edge:
 * memory against its limit is the OOMKill distance, CPU against its limit is where
 * throttling starts. A container with no limit shows its numbers in words instead of
 * a bar pretending there is a boundary.
 */
export function PodLiveUsage({ usage, available, reason }: Props) {
  // The sample age ticks finer than the poll, so "12s old" does not jump in tens.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!available) {
    return (
      <div className="usage-empty">
        <ShieldAlert size={16} aria-hidden />
        <p>{reason || 'Live usage is not available.'}</p>
      </div>
    );
  }

  if (!usage) {
    return <div className="usage-empty"><p>No usage sample for this pod yet. New pods appear on the next scrape.</p></div>;
  }

  return (
    <div className="usage-panel">
      <div className="usage-head">
        <span className="usage-total">
          <Activity size={14} aria-hidden />
          {usage.cpu_milli !== null ? formatCpuMilli(usage.cpu_milli) : '—'} CPU
          <span className="usage-dot" aria-hidden>·</span>
          {usage.memory_bytes !== null ? formatMemoryBytes(usage.memory_bytes) : '—'} memory
        </span>
        <span className="usage-sample">{describeSample(usage, now)}</span>
      </div>

      {usage.containers.map((container) => (
        <ContainerRow key={container.name} container={container} />
      ))}
    </div>
  );
}

function ContainerRow({ container }: { container: ContainerUsage }) {
  return (
    <div className="usage-container">
      <h4 className="mono">{container.name}</h4>
      <Meter
        label="Memory"
        value={container.memory_bytes}
        request={container.memory_request_bytes}
        limit={container.memory_limit_bytes}
        format={formatMemoryBytes}
        severityOf={memorySeverity}
        limitMeaning="the OOMKill point"
      />
      <Meter
        label="CPU"
        value={container.cpu_milli}
        request={container.cpu_request_milli}
        limit={container.cpu_limit_milli}
        format={formatCpuMilli}
        severityOf={cpuSeverity}
        limitMeaning="where throttling starts"
      />
    </div>
  );
}

function Meter({
  label, value, request, limit, format, severityOf, limitMeaning,
}: {
  label: string;
  value: number | null;
  request: number;
  limit: number;
  format: (value: number) => string;
  severityOf: (pct: number | null) => Severity | null;
  limitMeaning: string;
}) {
  const pct = pctOf(value, limit);
  const severity = severityOf(pct);

  return (
    <div className="usage-row">
      <span className="usage-label">{label}</span>
      <span className="usage-value mono">{value !== null ? format(value) : 'no sample'}</span>

      {pct !== null && severity ? (
        <span className="usage-meter" title={`${format(value ?? 0)} of the ${format(limit)} limit — ${limitMeaning}`}>
          <span
            className={`usage-meter-fill usage-${severity}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
          <span className={`usage-pct usage-text-${severity}`}>{pct.toFixed(0)}% of limit</span>
        </span>
      ) : (
        <span className="usage-unbounded viz-dim">
          {limit > 0 ? '' : 'no limit'}
          {request > 0 ? ` · request ${format(request)}` : limit > 0 ? '' : ' · no request'}
        </span>
      )}

      {pct !== null && request > 0 && (
        <span className="usage-request viz-dim">request {format(request)}</span>
      )}
    </div>
  );
}
