import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { CornerDownLeft, Search, ShieldAlert } from 'lucide-react';
import './palette.css';

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
};

export type SearchHit = {
  kind: string;
  name: string;
  namespace?: string;
  rank: number;
  detail: string;
};

type SearchResults = {
  query: string;
  hits: SearchHit[];
  truncated: boolean;
  degraded_collectors: string[];
};

type Props = {
  context: string;
  commands: PaletteCommand[];
  onOpenHit: (hit: SearchHit) => void;
  onClose: () => void;
};

/** Cluster-wide search costs a list per kind, so typing does not fire one per keystroke. */
const SEARCH_DEBOUNCE = 260;

export function CommandPalette({ context, commands, onOpenHit, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matchingCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (command) => command.label.toLowerCase().includes(needle) || command.group.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  // A flat list of everything selectable, so the arrow keys cross group boundaries.
  const rows = useMemo(
    () => [
      ...matchingCommands.map((command) => ({ type: 'command' as const, command })),
      ...(results?.hits ?? []).map((hit) => ({ type: 'hit' as const, hit })),
    ],
    [matchingCommands, results],
  );

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query, results]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(() => {
      void invoke<SearchResults>('search_cluster', { context, query: needle })
        .then((found) => {
          // A slower earlier search must not overwrite a newer one's results.
          setResults((current) => (current && current.query.length > found.query.length ? current : found));
        })
        .catch(() => setResults(null))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE);

    return () => window.clearTimeout(timer);
  }, [query, context]);

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onClose();
    if (row.type === 'command') row.command.run();
    else onOpenHit(row.hit);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector('.palette-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let cursor = -1;

  return createPortal(
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Search size={16} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search the cluster, or type a command…"
            aria-label="Search the cluster or run a command"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {matchingCommands.length > 0 && (
            <>
              <div className="palette-group">Commands</div>
              {matchingCommands.map((command) => {
                cursor += 1;
                const index = cursor;
                return (
                  <button
                    key={command.id}
                    type="button"
                    className={`palette-row${index === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(index)}
                  >
                    <span className="palette-label">{command.label}</span>
                    <span className="palette-meta">{command.hint ?? command.group}</span>
                    {index === active && <CornerDownLeft size={13} aria-hidden />}
                  </button>
                );
              })}
            </>
          )}

          {query.trim().length >= 2 && (
            <>
              <div className="palette-group">
                Cluster
                {searching && <span className="palette-searching">searching…</span>}
                {results?.truncated && <span className="palette-searching">showing the closest {results.hits.length}</span>}
              </div>

              {results?.hits.length === 0 && !searching && (
                <div className="palette-empty">Nothing in this cluster matches “{query.trim()}”.</div>
              )}

              {(results?.hits ?? []).map((found) => {
                cursor += 1;
                const index = cursor;
                return (
                  <button
                    key={`${found.kind}/${found.namespace ?? ''}/${found.name}`}
                    type="button"
                    className={`palette-row${index === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(index)}
                  >
                    <span className="palette-kind">{found.kind}</span>
                    <span className="palette-label mono">{found.name}</span>
                    <span className="palette-meta">
                      {found.namespace ? `${found.namespace} · ` : ''}
                      {found.detail}
                    </span>
                    {index === active && <CornerDownLeft size={13} aria-hidden />}
                  </button>
                );
              })}
            </>
          )}

          {results && results.degraded_collectors.length > 0 && (
            <div className="palette-note">
              <ShieldAlert size={13} aria-hidden />
              <span>{results.degraded_collectors.join(' ')}</span>
            </div>
          )}
        </div>

        <footer className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>Search covers every namespace this identity can read. Secret values are never shown.</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
