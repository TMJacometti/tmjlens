import { useState } from 'react';
import { CommandPalette, type SearchHit } from '../components/palette/CommandPalette';

/** The palette over a dimmed shell, with cluster search served by the preview stub. */
export function PalettePreview() {
  const [open, setOpen] = useState(true);
  const [chosen, setChosen] = useState<SearchHit | null>(null);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Command palette</h1>
          <p>{chosen ? `Opened ${chosen.kind} ${chosen.name}` : 'Press Ctrl+K in the app. Type to search the cluster.'}</p>
        </div>
      </div>
      {!open && (
        <button type="button" className="viz-toggle" onClick={() => setOpen(true)}>
          Reopen palette
        </button>
      )}
      {open && (
        <CommandPalette
          context="prod-shark"
          commands={[
            { id: 'a', label: 'Go to Cluster Overview', group: 'Navigate', run: () => undefined },
            { id: 'b', label: 'Go to Workloads', group: 'Navigate', run: () => undefined },
            { id: 'c', label: 'Generate executive report', group: 'Action', hint: 'PDF to Downloads', run: () => undefined },
          ]}
          onOpenHit={(hit) => setChosen(hit)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
