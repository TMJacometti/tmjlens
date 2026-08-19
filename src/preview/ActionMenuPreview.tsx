import { Download, ListTree, Trash2 } from 'lucide-react';
import { ActionMenu } from '../components/ActionMenu';

/**
 * Reproduces the condition the row menu has to survive: a `.panel`, which sets
 * `overflow: hidden` for its border radius, with the menu opened on the last row.
 * An absolutely positioned menu is clipped here; a portalled one is not.
 */
const rows = [
  'checkout-api-685575b4d4-z4w6r',
  'checkout-worker-7c9d8f6b5a-mn2kq',
  'ingress-nginx-controller-6c9d8f7b5a-tt41z',
  'otel-collector-9f8d7c6b5a-qq41z',
];

export function ActionMenuPreview() {
  return (
    <div className="panel">
      <div className="panel-head">
        <span>Pods</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Ready</th>
            <th>Age</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((name) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td>
                <span className="status good">
                  <span className="dot" />
                  Running
                </span>
              </td>
              <td>1/1</td>
              <td>1d</td>
              <td className="action-cell">
                <ActionMenu
                  label="Pod actions"
                  items={[
                    { label: 'Open details', icon: <ListTree size={14} />, onSelect: () => undefined },
                    { label: 'Download logs', icon: <Download size={14} />, onSelect: () => undefined },
                    { label: 'Delete pod', icon: <Trash2 size={14} />, danger: true, onSelect: () => undefined },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
