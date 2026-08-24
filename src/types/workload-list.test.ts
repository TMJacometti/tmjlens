import { describe, expect, it } from 'vitest';
import { canRestartKind, canScaleKind } from './workload-list';

describe('which kinds can be scaled', () => {
  it('offers scaling where the replica count is the operators to set', () => {
    expect(canScaleKind('Deployment')).toBe(true);
    expect(canScaleKind('StatefulSet')).toBe(true);
  });

  it('refuses the kinds where scaling is a trap', () => {
    // A ReplicaSet owned by a Deployment is scaled straight back by its controller,
    // and a DaemonSet's count is the node list.
    expect(canScaleKind('ReplicaSet')).toBe(false);
    expect(canScaleKind('DaemonSet')).toBe(false);
    expect(canScaleKind('Job')).toBe(false);
    expect(canScaleKind('CronJob')).toBe(false);
  });
});

describe('which kinds can be rollout-restarted', () => {
  it('offers a restart wherever a live pod template exists', () => {
    expect(canRestartKind('Deployment')).toBe(true);
    expect(canRestartKind('StatefulSet')).toBe(true);
    expect(canRestartKind('DaemonSet')).toBe(true);
  });

  it('refuses the kinds with nothing to roll', () => {
    expect(canRestartKind('Job')).toBe(false);
    expect(canRestartKind('CronJob')).toBe(false);
    expect(canRestartKind('ReplicaSet')).toBe(false);
  });
});
