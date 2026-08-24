import { describe, expect, it } from 'vitest';
import { ageFrom } from './format';

/**
 * ageFrom mirrors the backend's format_age exactly: floor division, s/m/h/d. The two
 * render the same pod, so any drift would show as an age that changes when the row is
 * re-sent by the watch.
 */
describe('ticking ages', () => {
  const at = Date.parse('2026-08-24T12:00:00Z');
  const ago = (seconds: number) => new Date(at - seconds * 1000).toISOString();

  it('matches the backend format at each unit boundary', () => {
    expect(ageFrom(ago(0), at)).toBe('0s');
    expect(ageFrom(ago(59), at)).toBe('59s');
    expect(ageFrom(ago(60), at)).toBe('1m');
    expect(ageFrom(ago(3_599), at)).toBe('59m');
    expect(ageFrom(ago(3_600), at)).toBe('1h');
    expect(ageFrom(ago(86_399), at)).toBe('23h');
    expect(ageFrom(ago(86_400), at)).toBe('1d');
    expect(ageFrom(ago(86_400 * 31), at)).toBe('31d');
  });

  it('floors rather than rounds, as the backend does', () => {
    // 89 seconds is 1m, not 2m — rounding would disagree with the server string.
    expect(ageFrom(ago(89), at)).toBe('1m');
    expect(ageFrom(ago(90), at)).toBe('1m');
  });

  it('never renders a negative age from clock skew', () => {
    expect(ageFrom(new Date(at + 30_000).toISOString(), at)).toBe('0s');
  });

  it('says n/a for a timestamp it cannot parse', () => {
    expect(ageFrom('not a date', at)).toBe('n/a');
  });
});
