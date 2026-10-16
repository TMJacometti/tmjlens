/**
 * The database the server runs on, as the About tab names it. The version is
 * pinned by Cargo.lock; version-sync.test.ts fails the moment they disagree,
 * so About never names an engine the build does not ship.
 */
export const DATABASE_ENGINE = {
  name: 'tmjLite',
  version: '0.3.5',
  driver: 'tmjlite crate (official Rust driver)',
} as const;
