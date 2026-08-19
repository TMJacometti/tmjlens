export type DiffLine = {
  type: 'add' | 'remove' | 'context';
  text: string;
  /** 1-based line number in the original document, absent on added lines. */
  oldLine?: number;
  /** 1-based line number in the edited document, absent on removed lines. */
  newLine?: number;
};

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

/**
 * Beyond this many differing lines on a side, the quadratic table is abandoned and
 * the changed region is reported as a wholesale replacement. A diff that large is not
 * something a person reads line by line anyway, and the editor must not freeze.
 */
const LCS_LIMIT = 2000;

/**
 * Line diff between two documents.
 *
 * The common prefix and suffix are stripped before the table is built, which is what
 * keeps this cheap for the case that actually happens — a handful of edited lines in
 * a long manifest reduces to a table of a few cells.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const result: DiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    result.push({ type: 'context', text: oldLines[index], oldLine: index + 1, newLine: index + 1 });
  }

  const middle =
    oldMiddle.length > LCS_LIMIT || newMiddle.length > LCS_LIMIT
      ? wholesale(oldMiddle, newMiddle, prefix)
      : align(oldMiddle, newMiddle, prefix);
  result.push(...middle);

  for (let index = 0; index < suffix; index += 1) {
    result.push({
      type: 'context',
      text: oldLines[oldLines.length - suffix + index],
      oldLine: oldLines.length - suffix + index + 1,
      newLine: newLines.length - suffix + index + 1,
    });
  }

  return result;
}

function wholesale(oldMiddle: string[], newMiddle: string[], offset: number): DiffLine[] {
  return [
    ...oldMiddle.map((text, index) => ({ type: 'remove' as const, text, oldLine: offset + index + 1 })),
    ...newMiddle.map((text, index) => ({ type: 'add' as const, text, newLine: offset + index + 1 })),
  ];
}

/** Standard longest-common-subsequence alignment over the differing region. */
function align(oldMiddle: string[], newMiddle: string[], offset: number): DiffLine[] {
  const rows = oldMiddle.length;
  const columns = newMiddle.length;
  const table = new Int32Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[at(row, column)] =
        oldMiddle[row] === newMiddle[column]
          ? table[at(row + 1, column + 1)] + 1
          : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldMiddle[row] === newMiddle[column]) {
      lines.push({ type: 'context', text: oldMiddle[row], oldLine: offset + row + 1, newLine: offset + column + 1 });
      row += 1;
      column += 1;
    } else if (table[at(row + 1, column)] >= table[at(row, column + 1)]) {
      lines.push({ type: 'remove', text: oldMiddle[row], oldLine: offset + row + 1 });
      row += 1;
    } else {
      lines.push({ type: 'add', text: newMiddle[column], newLine: offset + column + 1 });
      column += 1;
    }
  }
  while (row < rows) {
    lines.push({ type: 'remove', text: oldMiddle[row], oldLine: offset + row + 1 });
    row += 1;
  }
  while (column < columns) {
    lines.push({ type: 'add', text: newMiddle[column], newLine: offset + column + 1 });
    column += 1;
  }

  return lines;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.type === 'add').length,
    removed: lines.filter((line) => line.type === 'remove').length,
  };
}

/**
 * Groups changes into hunks with surrounding context, dropping the untouched bulk.
 * A manifest is mostly unchanged; showing all of it buries the edit being reviewed.
 */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines
    .map((line, index) => (line.type === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    // Merge with the previous range when the gap between them is only context.
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  return ranges.map(([from, to]) => {
    const slice = lines.slice(from, to + 1);
    return {
      oldStart: slice.find((line) => line.oldLine !== undefined)?.oldLine ?? 0,
      newStart: slice.find((line) => line.newLine !== undefined)?.newLine ?? 0,
      lines: slice,
    };
  });
}
