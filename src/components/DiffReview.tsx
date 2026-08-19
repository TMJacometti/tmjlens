import { diffLines, diffStats, toHunks } from '../lib/diff';

/**
 * The change under review, before it is written to a live cluster.
 *
 * Only the changed regions are shown, with a few lines of context. A manifest is
 * mostly unchanged, and rendering all of it buries the one edit being reviewed —
 * which is the whole point of asking for a review.
 */
export function DiffReview({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  const { added, removed } = diffStats(lines);
  const hunks = toHunks(lines);

  if (hunks.length === 0) {
    return <div className="viz-empty">The document is unchanged.</div>;
  }

  return (
    <div className="diff">
      <div className="diff-summary">
        <span className="diff-added">+{added}</span>
        <span className="diff-removed">−{removed}</span>
        <span className="viz-dim">
          {hunks.length} changed {hunks.length === 1 ? 'region' : 'regions'}
        </span>
      </div>

      {hunks.map((hunk, index) => (
        <section className="diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}-${index}`}>
          <header>
            line {hunk.oldStart} → {hunk.newStart}
          </header>
          {hunk.lines.map((line, lineIndex) => (
            <div className={`diff-line diff-${line.type}`} key={lineIndex}>
              <span className="diff-num">{line.oldLine ?? ''}</span>
              <span className="diff-num">{line.newLine ?? ''}</span>
              {/* The sign is written, so the change is not carried by colour alone. */}
              <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
              <span className="diff-text">{line.text || ' '}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
