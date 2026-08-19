import { describe, expect, it } from 'vitest';
import {
  formatStorage, parseStorage, shortHandle, summariseCapacity,
  type ClaimInfo, type StorageOverview, type VolumeInfo,
} from './storage';

const claim = (overrides: Partial<ClaimInfo>): ClaimInfo => ({
  name: 'c', phase: 'Bound', health: 'good', reason: '', requested: '10Gi', provisioned: '10Gi',
  over_provisioned: null, storage_class: 'gp3', access_modes: ['ReadWriteOnce'],
  volume_mode: 'Filesystem', volume: 'pvc-1', used_by: ['pod'], used_by_total: 1, age: '1d',
  ...overrides,
});

const volume = (overrides: Partial<VolumeInfo>): VolumeInfo => ({
  name: 'v', phase: 'Bound', health: 'good', reason: '', capacity: '10Gi',
  reclaim_policy: 'Delete', storage_class: 'gp3', access_modes: ['ReadWriteOnce'],
  claim: 'ns/c', claim_exists: true, source: 'ebs.csi.aws.com', handle: 'vol-1', zones: [], age: '1d',
  ...overrides,
});

const overview = (claims: ClaimInfo[], volumes: VolumeInfo[] = []): StorageOverview => ({
  namespace: 'payments', claims, volumes, classes: [], findings: [], degraded_collectors: [],
});

describe('quantities', () => {
  it('parses binary and decimal suffixes', () => {
    expect(parseStorage('1Gi')).toBe(1024 ** 3);
    expect(parseStorage('100Gi')).toBe(100 * 1024 ** 3);
    expect(parseStorage('1G')).toBe(1e9);
    expect(parseStorage('512Mi')).toBe(512 * 1024 ** 2);
    expect(parseStorage('1024')).toBe(1024);
  });

  it('returns null rather than zero for what it cannot read', () => {
    // Counting an unreadable size as zero would quietly under-report a total.
    expect(parseStorage('big')).toBeNull();
    expect(parseStorage('10Zz')).toBeNull();
    expect(parseStorage(null)).toBeNull();
    expect(parseStorage('')).toBeNull();
  });

  it('round-trips through the formatter at the same scale', () => {
    expect(formatStorage(parseStorage('100Gi')!)).toBe('100Gi');
    expect(formatStorage(parseStorage('2Ti')!)).toBe('2.0Ti');
    expect(formatStorage(parseStorage('512Mi')!)).toBe('512Mi');
  });
});

describe('capacity split', () => {
  it('separates what is mounted from what is merely bound', () => {
    const summary = summariseCapacity(overview([
      claim({ name: 'a', provisioned: '100Gi', used_by_total: 2 }),
      claim({ name: 'b', provisioned: '50Gi', used_by_total: 0, used_by: [] }),
    ]));
    expect(summary.inUse).toBe(100 * 1024 ** 3);
    expect(summary.idle).toBe(50 * 1024 ** 3);
    expect(summary.total).toBe(150 * 1024 ** 3);
  });

  it('counts released volumes as stranded, not as in use', () => {
    const summary = summariseCapacity(overview([], [
      volume({ name: 'r', phase: 'Released', capacity: '500Gi', reclaim_policy: 'Retain' }),
      volume({ name: 'f', phase: 'Failed', capacity: '200Gi' }),
    ]));
    expect(summary.stranded).toBe(700 * 1024 ** 3);
    expect(summary.inUse).toBe(0);
  });

  it('does not count a bound volume as well as its claim', () => {
    // Both objects describe the same disk; adding both would double the total.
    const summary = summariseCapacity(overview(
      [claim({ provisioned: '100Gi', used_by_total: 1 })],
      [volume({ phase: 'Bound', capacity: '100Gi' })],
    ));
    expect(summary.total).toBe(100 * 1024 ** 3);
  });

  it('ignores a claim with no volume, which is billing nothing yet', () => {
    const summary = summariseCapacity(overview([
      claim({ phase: 'Pending', provisioned: null, requested: '20Gi', used_by_total: 0, used_by: [] }),
    ]));
    expect(summary.total).toBe(0);
  });

  it('ignores a lost claim, whose volume no longer exists to be billed', () => {
    const summary = summariseCapacity(overview([
      claim({ phase: 'Lost', provisioned: '50Gi', used_by_total: 0, used_by: [] }),
    ]));
    expect(summary.total).toBe(0);
  });

  it('counts what it could not measure instead of dropping it silently', () => {
    const summary = summariseCapacity(overview([
      claim({ provisioned: 'unknown', used_by_total: 1 }),
      claim({ name: 'b', provisioned: '10Gi', used_by_total: 1 }),
    ]));
    expect(summary.unmeasured).toBe(1);
    expect(summary.inUse).toBe(10 * 1024 ** 3);
  });

  it('falls back to the request when nothing reported what was provisioned', () => {
    const summary = summariseCapacity(overview([
      claim({ provisioned: null, requested: '30Gi', used_by_total: 1 }),
    ]));
    expect(summary.inUse).toBe(30 * 1024 ** 3);
  });
});

describe('disk handles', () => {
  it('leaves a plain volume id alone', () => {
    expect(shortHandle('vol-0a1b2c3d4e5f60718')).toBe('vol-0a1b2c3d4e5f60718');
  });

  it('shortens a cloud resource path to the disk itself', () => {
    expect(shortHandle('/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/disks/pvc-9')).toBe('pvc-9');
    expect(shortHandle('projects/acme/zones/europe-west1-b/disks/pvc-4')).toBe('pvc-4');
  });

  it('keeps an NFS export whole, where the host is half the address', () => {
    expect(shortHandle('nfs.internal:/exports/reports')).toBe('nfs.internal:/exports/reports');
  });

  it('says nothing rather than an empty cell when there is no handle', () => {
    expect(shortHandle(null)).toBe('—');
  });
});
