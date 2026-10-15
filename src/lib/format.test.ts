import { describe, expect, it } from 'vitest';
import { formatBytes, formatCpu, formatMemoryPair, formatMemoryQuantity, formatPercent } from './format';

/**
 * Regression for the web Cluster Overview crash: Rust's Option<f64> arrives as
 * JSON null, not undefined. A node the metrics server has not measured yet must
 * render as '—', never reach .toFixed.
 */
/**
 * Production showed "2.9 GiB" for a request the manifest spells 3000Mi, and
 * the operator read it as a different number. Requests print as kubectl
 * would; the measurement beside them borrows the unit.
 */
describe('memory as kubectl prints it', () => {
  it('keeps whole Mi and whole Gi in their own unit', () => {
    expect(formatMemoryQuantity(3000 * 1024 * 1024)).toBe('3000Mi');
    expect(formatMemoryQuantity(4000 * 1024 * 1024)).toBe('4000Mi');
    expect(formatMemoryQuantity(4 * 1024 ** 3)).toBe('4Gi');
    expect(formatMemoryQuantity(512 * 1024 * 1024)).toBe('512Mi');
    expect(formatMemoryQuantity(1024 ** 3)).toBe('1Gi');
  });

  it('falls back to bytes for anything that is not a whole binary unit', () => {
    expect(formatMemoryQuantity(1.5 * 1024 ** 3)).toBe('1536Mi');
    expect(formatMemoryQuantity(1.5 * 1024 ** 3 + 1)).toBe('1.5 GiB');
    expect(formatMemoryQuantity(1234567)).toBe('1.2 MiB');
    expect(formatMemoryQuantity(null)).toBe('—');
  });

  it('prints the measurement in the unit of the request', () => {
    expect(formatMemoryPair(3000 * 1024 * 1024, 2.2 * 1024 ** 3)).toBe('3000Mi / 2253Mi');
    expect(formatMemoryPair(4 * 1024 ** 3, 1.5 * 1024 ** 3)).toBe('4Gi / 1.5Gi');
    expect(formatMemoryPair(512 * 1024 * 1024, 120 * 1024 * 1024)).toBe('512Mi / 120Mi');
    expect(formatMemoryPair(null, 120 * 1024 * 1024)).toBe('— / 120 MiB');
    expect(formatMemoryPair(512 * 1024 * 1024, null)).toBe('512Mi / —');
  });
});

describe('absent measurements', () => {
  it('renders null as a dash, the same as undefined', () => {
    expect(formatCpu(null)).toBe('—');
    expect(formatCpu(undefined)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('does not confuse zero with absent', () => {
    expect(formatCpu(0)).toBe('0m');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('real measurements keep their scales', () => {
  it('cpu: millicores below one core, cores above', () => {
    expect(formatCpu(250)).toBe('250m');
    expect(formatCpu(1500)).toBe('1.5 cores');
    expect(formatCpu(12000)).toBe('12 cores');
  });

  it('bytes walk the binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});
