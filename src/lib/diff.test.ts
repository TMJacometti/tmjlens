import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, toHunks } from './diff';

const render = (before: string, after: string) =>
  diffLines(before, after).map((line) => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`);

describe('diffLines', () => {
  it('reports nothing for an unchanged document', () => {
    const body = 'apiVersion: v1\nkind: Service\n';
    expect(diffStats(diffLines(body, body))).toEqual({ added: 0, removed: 0 });
    expect(toHunks(diffLines(body, body))).toEqual([]);
  });

  it('sees a single edited line as one removal and one addition', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('sees an inserted line without disturbing its neighbours', () => {
    expect(render('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
  });

  it('sees a deleted line', () => {
    expect(render('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
  });

  it('numbers lines against the document each side belongs to', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    const removed = lines.find((line) => line.type === 'remove');
    expect(removed?.oldLine).toBe(2);
    expect(removed?.newLine).toBeUndefined();

    const last = lines[lines.length - 1];
    expect(last.oldLine).toBe(3);
    expect(last.newLine).toBe(2);
  });

  it('keeps the common prefix and suffix as context around the change', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'b', 'X', 'd', 'e'].join('\n');
    expect(render(before, after)).toEqual([' a', ' b', '-c', '+X', ' d', ' e']);
  });

  it('handles an edit inside a long document without exploding', () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `line-${index}`);
    const edited = [...lines];
    edited[2000] = 'line-2000-edited';

    // The prefix/suffix trim leaves a single differing line, so this stays cheap
    // even though the document is far past the quadratic limit.
    const stats = diffStats(diffLines(lines.join('\n'), edited.join('\n')));
    expect(stats).toEqual({ added: 1, removed: 1 });
  });

  it('falls back to a wholesale replacement when the changed region is too large', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `old-${index}`).join('\n');
    const after = Array.from({ length: 2500 }, (_, index) => `new-${index}`).join('\n');
    expect(diffStats(diffLines(before, after))).toEqual({ added: 2500, removed: 2500 });
  });
});

describe('toHunks', () => {
  it('drops the untouched bulk and keeps context around each change', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line-${index}`);
    const after = [...before];
    after[20] = 'changed';

    const hunks = toHunks(diffLines(before.join('\n'), after.join('\n')), 2);
    expect(hunks).toHaveLength(1);
    // Two context lines either side, plus the removal and the addition.
    expect(hunks[0].lines).toHaveLength(6);
    expect(hunks[0].oldStart).toBe(19);
  });

  it('merges changes that sit within context of each other', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line-${index}`);
    const after = [...before];
    after[5] = 'a';
    after[7] = 'b';

    expect(toHunks(diffLines(before.join('\n'), after.join('\n')), 3)).toHaveLength(1);
  });

  it('keeps distant changes in separate hunks', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line-${index}`);
    const after = [...before];
    after[5] = 'a';
    after[30] = 'b';

    expect(toHunks(diffLines(before.join('\n'), after.join('\n')), 2)).toHaveLength(2);
  });
});
