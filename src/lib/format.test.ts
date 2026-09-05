import { describe, expect, it } from 'vitest';
import { formatBytes, formatCpu, formatPercent } from './format';

/**
 * Regression for the web Cluster Overview crash: Rust's Option<f64> arrives as
 * JSON null, not undefined. A node the metrics server has not measured yet must
 * render as '—', never reach .toFixed.
 */
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
