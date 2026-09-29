import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * v0.6.3 never built: Cargo.toml was bumped, Cargo.lock was not, and the
 * image build runs `cargo build --locked`, which refuses to touch the lock.
 * Three files carry the version and the lock echoes one of them; this test
 * runs with every frontend suite and fails the moment any of them drifts.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('release version is one number everywhere', () => {
  const pkg = (JSON.parse(read('./package.json')) as { version: string }).version;
  const cargoToml = /^version\s*=\s*"([^"]+)"/m.exec(read('../src-tauri/Cargo.toml'))?.[1];
  const tauriConf = (JSON.parse(read('../src-tauri/tauri.conf.json')) as { version: string }).version;
  const lock = /name = "tmjlens"\nversion = "([^"]+)"/.exec(read('../src-tauri/Cargo.lock'))?.[1];

  it('package.json, Cargo.toml and tauri.conf.json agree', () => {
    expect(cargoToml).toBe(pkg);
    expect(tauriConf).toBe(pkg);
  });

  it('Cargo.lock was regenerated after the bump (cargo build --locked depends on it)', () => {
    expect(lock).toBe(cargoToml);
  });
});
