import { describe, expect, it } from 'vitest';
import {
  cpuSeverity, describeSample, formatCpuMilli, memorySeverity, pctOf, sampleAgeSeconds,
  type PodUsageRow,
} from './metrics';

describe('cpu formatting', () => {
  it('scales from millicores to cores', () => {
    expect(formatCpuMilli(0.4)).toBe('<1m');
    expect(formatCpuMilli(412)).toBe('412m');
    expect(formatCpuMilli(1400)).toBe('1.4 cores');
    expect(formatCpuMilli(12_000)).toBe('12 cores');
  });
});

describe('percent of a bound', () => {
  it('is null without a bound, because a meter needs a real edge', () => {
    expect(pctOf(500, 0)).toBeNull();
    expect(pctOf(null, 1000)).toBeNull();
  });

  it('computes against the bound when one exists', () => {
    expect(pctOf(500, 1000)).toBe(50);
  });
});

describe('memory severity', () => {
  it('escalates toward the OOMKill point', () => {
    expect(memorySeverity(50)).toBe('good');
    expect(memorySeverity(70)).toBe('warning');
    expect(memorySeverity(85)).toBe('serious');
    expect(memorySeverity(96)).toBe('critical');
  });

  it('has no opinion without a limit', () => {
    expect(memorySeverity(null)).toBeNull();
  });
});

describe('cpu severity', () => {
  it('caps at warning, because throttling is latency rather than death', () => {
    expect(cpuSeverity(99)).toBe('good');
    expect(cpuSeverity(100)).toBe('warning');
    expect(cpuSeverity(180)).toBe('warning');
  });
});

describe('sample honesty', () => {
  const now = Date.parse('2026-08-24T12:00:30Z');
  const row = (sampled: string | null): PodUsageRow => ({
    name: 'p', cpu_milli: 1, memory_bytes: 1, cpu_request_milli: 0, cpu_limit_milli: 0,
    memory_request_bytes: 0, memory_limit_bytes: 0, containers: [],
    sampled_at: sampled, window: '30s',
  });

  it('says how old the sample is and what window it covers', () => {
    expect(describeSample(row('2026-08-24T12:00:18Z'), now)).toBe('sample 12s old · 30s window');
  });

  it('never reports a negative age from clock skew', () => {
    expect(sampleAgeSeconds('2026-08-24T12:01:00Z', now)).toBe(0);
  });

  it('omits what it does not know instead of guessing', () => {
    expect(describeSample(row(null), now)).toBe('30s window');
  });
});
