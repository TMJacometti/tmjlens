import { useMemo } from 'react';
import { SeverityBadge } from '../cluster/charts';
import type { Severity } from '../../types/cluster';
import './graph.css';

export type GraphNode = {
  id: string;
  kind: string;
  name: string;
  tier: number;
  health: Severity;
  detail: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  relation: string;
  /** Set when the link is declared but does not resolve. */
  broken?: string;
};

export type RelationGraphData = {
  root: string;
  namespace: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  degraded_collectors: string[];
};

const TIERS = ['Ingress', 'Service', 'Controller', 'ReplicaSet', 'Pods', 'Config'];

const NODE_WIDTH = 210;
const NODE_HEIGHT = 54;
const ROW_GAP = 14;
const COLUMN_GAP = 74;

/**
 * The relation graph, drawn as tiers left to right.
 *
 * A force-directed layout would move every node whenever anything changed, which makes
 * a diagnosis harder to follow across refreshes. Kubernetes ownership is already a
 * hierarchy, so the tiers are fixed and a node keeps its place.
 */
export function RelationGraph({ data, onSelect }: { data: RelationGraphData; onSelect?: (node: GraphNode) => void }) {
  const layout = useMemo(() => {
    const columns = new Map<number, GraphNode[]>();
    for (const node of data.nodes) {
      const bucket = columns.get(node.tier) ?? [];
      bucket.push(node);
      columns.set(node.tier, bucket);
    }

    const present = [...columns.keys()].sort((left, right) => left - right);
    const positions = new Map<string, { x: number; y: number }>();
    const tallest = Math.max(...present.map((tier) => columns.get(tier)!.length), 1);
    const height = tallest * (NODE_HEIGHT + ROW_GAP) + 40;

    present.forEach((tier, columnIndex) => {
      const bucket = columns.get(tier)!;
      const columnHeight = bucket.length * (NODE_HEIGHT + ROW_GAP);
      const top = (height - columnHeight) / 2;
      bucket.forEach((node, rowIndex) => {
        positions.set(node.id, {
          x: columnIndex * (NODE_WIDTH + COLUMN_GAP) + 10,
          y: top + rowIndex * (NODE_HEIGHT + ROW_GAP),
        });
      });
    });

    return {
      positions,
      present,
      width: present.length * (NODE_WIDTH + COLUMN_GAP) + 20,
      height,
    };
  }, [data]);

  if (data.nodes.length === 0) {
    return <div className="viz-empty">Nothing is connected to this workload yet.</div>;
  }

  return (
    <div className="graph">
      <div className="graph-legend">
        {layout.present.map((tier, index) => (
          <span key={tier} style={{ left: index * (NODE_WIDTH + COLUMN_GAP) + 10, width: NODE_WIDTH }}>
            {TIERS[tier] ?? `Tier ${tier}`}
          </span>
        ))}
      </div>

      <div className="graph-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} className="graph-edges" aria-hidden>
          {data.edges.map((edge, index) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;

            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const midpoint = (x1 + x2) / 2;

            return (
              <g key={`${edge.from}->${edge.to}-${index}`}>
                <path
                  d={`M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}`}
                  className={edge.broken ? 'graph-edge is-broken' : 'graph-edge'}
                />
                <title>{edge.broken ? `${edge.relation} — ${edge.broken}` : edge.relation}</title>
              </g>
            );
          })}
        </svg>

        {data.nodes.map((node) => {
          const position = layout.positions.get(node.id)!;
          const isRoot = node.id === data.root;
          return (
            <button
              key={node.id}
              type="button"
              className={`graph-node graph-node-${node.health}${isRoot ? ' is-root' : ''}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              onClick={() => onSelect?.(node)}
              title={`${node.kind} ${node.name} — ${node.detail}`}
            >
              <span className="graph-kind">{node.kind}</span>
              <span className="graph-name mono">{node.name}</span>
              <span className="graph-detail">{node.detail}</span>
            </button>
          );
        })}
      </div>

      <ul className="graph-problems">
        {data.edges
          .filter((edge) => edge.broken)
          .map((edge, index) => (
            <li key={index}>
              <SeverityBadge severity="critical" />
              <span className="mono">{edge.from.split('/')[1]}</span>
              <span className="viz-dim">{edge.relation}</span>
              <span className="mono">{edge.to.split('/')[1]}</span>
              <em>{edge.broken}</em>
            </li>
          ))}
      </ul>
    </div>
  );
}
