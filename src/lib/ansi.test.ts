import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi';

const ESC = '';
const BEL = '';

describe('stripAnsi', () => {
  it('leaves plain text untouched', () => {
    expect(stripAnsi('starting worker 3')).toBe('starting worker 3');
    expect(stripAnsi('')).toBe('');
  });

  it('removes colour sequences and keeps what they wrapped', () => {
    expect(stripAnsi(`${ESC}[0;32mready${ESC}[0m`)).toBe('ready');
    expect(stripAnsi(`${ESC}[1;31mERROR${ESC}[0m connection refused`)).toBe('ERROR connection refused');
  });

  it('removes cursor movement, so a container cannot redraw the view', () => {
    expect(stripAnsi(`before${ESC}[2J${ESC}[Hafter`)).toBe('beforeafter');
    expect(stripAnsi(`line${ESC}[5Aup`)).toBe('lineup');
  });

  it('removes an OSC sequence ended by BEL', () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}text`)).toBe('text');
  });

  it('removes an OSC sequence ended by the string terminator', () => {
    expect(stripAnsi(`${ESC}]0;title${ESC}\\text`)).toBe('text');
  });

  it('removes two-character escapes', () => {
    expect(stripAnsi(`${ESC}(Bplain`)).toBe('plain');
  });

  it('drops a bare bell', () => {
    expect(stripAnsi(`done${BEL}`)).toBe('done');
  });

  it('survives a truncated sequence at the end of a chunk', () => {
    // Output arrives in chunks, so a sequence can be cut in half.
    expect(stripAnsi(`text${ESC}`)).toBe('text');
    expect(stripAnsi(`text${ESC}[`)).toBe('text');
    expect(stripAnsi(`text${ESC}[0`)).toBe('text');
  });

  it('keeps newlines and tabs, which are content', () => {
    expect(stripAnsi('a\nb\tc')).toBe('a\nb\tc');
  });
});
