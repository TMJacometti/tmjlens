import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, XCircle } from 'lucide-react';
import type { Severity } from '../../types/cluster';

export function severityVar(severity: Severity): string {
  return `var(--status-${severity})`;
}

export function severityLabel(severity: Severity): string {
  return { good: 'Healthy', warning: 'Warning', serious: 'Serious', critical: 'Critical' }[severity];
}

/** Status never travels as colour alone — every badge carries its icon and word. */
export function SeverityBadge({ severity, label }: { severity: Severity; label?: string }) {
  const Icon = { good: CheckCircle2, warning: AlertTriangle, serious: CircleAlert, critical: XCircle }[severity];
  return (
    <span className={`viz-badge viz-badge-${severity}`}>
      <Icon size={13} aria-hidden />
      {label ?? severityLabel(severity)}
    </span>
  );
}

type TipState = { x: number; y: number; node: React.ReactNode } | null;

export function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState>(null);

  const show = useCallback((event: React.MouseEvent | React.FocusEvent, node: React.ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const point =
      'clientX' in event
        ? { x: event.clientX, y: event.clientY }
        : (() => {
            const target = (event.target as HTMLElement).getBoundingClientRect();
            return { x: target.left + target.width / 2, y: target.top };
          })();
    setTip({
      x: Math.min(Math.max(point.x - box.left, 70), Math.max(box.width - 70, 70)),
      y: point.y - box.top,
      node,
    });
  }, []);

  const hide = useCallback(() => setTip(null), []);
  return { ref, tip, show, hide };
}

export function TooltipLayer({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.node}
    </div>
  );
}

export function ChartCard({
  title,
  subtitle,
  legend,
  action,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: LegendEntry[];
  action?: React.ReactNode;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      {legend && legend.length > 1 && <Legend entries={legend} />}
      {empty ? <div className="viz-empty">{empty}</div> : <div className="viz-card-body">{children}</div>}
    </section>
  );
}

export type LegendEntry = { label: string; color: string; severity?: Severity };

export function Legend({ entries }: { entries: LegendEntry[] }) {
  return (
    <ul className="viz-legend">
      {entries.map((entry) => (
        <li key={entry.label}>
          <span className="viz-swatch" style={{ background: entry.color }} aria-hidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

export type RankedItem = {
  key: string;
  label: string;
  value: number;
  /** Drawn as a second bar in the same row against the same axis, never a second scale. */
  secondary?: number;
  /** Overrides the printed value — use it to say "not measured" rather than "zero". */
  valueLabel?: string;
  tooltip: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
};

export function RankedBars({
  items,
  max,
  formatValue,
  labelWidth = 150,
  primaryColor,
}: {
  items: RankedItem[];
  max: number;
  formatValue: (value: number) => string;
  labelWidth?: number;
  /** Set it when the plotted measure has a fixed colour in the page's resource palette. */
  primaryColor?: string;
}) {
  const { ref, tip, show, hide } = useTooltip();
  const axis = max > 0 ? max : 1;

  return (
    <div className="viz-ranked" ref={ref} style={{ ['--viz-label-width' as string]: `${labelWidth}px` }}>
      {items.map((item) => (
        <div
          className={`viz-ranked-row${item.onClick ? ' is-clickable' : ''}`}
          key={item.key}
          tabIndex={0}
          role={item.onClick ? 'button' : 'group'}
          onClick={item.onClick}
          onKeyDown={(event) => {
            if (item.onClick && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              item.onClick();
            }
          }}
          onMouseMove={(event) => show(event, item.tooltip)}
          onMouseLeave={hide}
          onFocus={(event) => show(event, item.tooltip)}
          onBlur={hide}
        >
          <span className="viz-ranked-label" title={item.label}>
            {item.label}
          </span>
          <div className="viz-ranked-plot">
            <div className="viz-track">
              {/* A zero value draws nothing — a minimum-width nub would read as a measurement. */}
              {item.value > 0 && (
                <div
                  className="viz-bar viz-bar-primary"
                  style={{ width: `${Math.min((item.value / axis) * 100, 100)}%`, background: primaryColor }}
                />
              )}
            </div>
            {item.secondary !== undefined && (
              <div className="viz-track viz-track-secondary">
                {item.secondary > 0 && (
                  <div className="viz-bar viz-bar-secondary" style={{ width: `${Math.min((item.secondary / axis) * 100, 100)}%` }} />
                )}
              </div>
            )}
          </div>
          <span className="viz-ranked-value">{item.valueLabel ?? formatValue(item.value)}</span>
          {item.trailing}
        </div>
      ))}
      <TooltipLayer tip={tip} />
    </div>
  );
}

export type StackSegment = { key: string; label: string; value: number; color: string };

export function StackedBar({
  segments,
  total,
  formatValue,
}: {
  segments: StackSegment[];
  total: number;
  formatValue: (value: number) => string;
}) {
  const { ref, tip, show, hide } = useTooltip();
  const visible = segments.filter((segment) => segment.value > 0);
  const axis = total > 0 ? total : 1;

  return (
    <div className="viz-stack-wrap" ref={ref}>
      <div className="viz-stack">
        {visible.map((segment) => (
          <div
            key={segment.key}
            className="viz-stack-segment"
            tabIndex={0}
            style={{ flexBasis: `${(segment.value / axis) * 100}%`, background: segment.color }}
            onMouseMove={(event) =>
              show(
                event,
                <>
                  <strong>{segment.label}</strong>
                  <span>
                    {formatValue(segment.value)} · {Math.round((segment.value / axis) * 100)}%
                  </span>
                </>,
              )
            }
            onMouseLeave={hide}
            onFocus={(event) =>
              show(
                event,
                <>
                  <strong>{segment.label}</strong>
                  <span>{formatValue(segment.value)}</span>
                </>,
              )
            }
            onBlur={hide}
          />
        ))}
      </div>
      <TooltipLayer tip={tip} />
    </div>
  );
}

/**
 * Requests, limits, and live usage share one axis. Limits may exceed allocatable —
 * that overcommit is the point, so the axis grows and a rule marks allocatable.
 */
export function CapacityAxis({
  allocatable,
  rows,
  format,
}: {
  allocatable: number;
  rows: { key: string; label: string; value: number; color: string; note?: string }[];
  format: (value: number) => string;
}) {
  const { ref, tip, show, hide } = useTooltip();
  const max = Math.max(allocatable, ...rows.map((row) => row.value)) || 1;
  const allocatableOffset = (allocatable / max) * 100;

  return (
    <div className="viz-capacity" ref={ref}>
      {rows.map((row) => (
        <div
          className="viz-capacity-row"
          key={row.key}
          tabIndex={0}
          onMouseMove={(event) =>
            show(
              event,
              <>
                <strong>{row.label}</strong>
                <span>
                  {format(row.value)} · {Math.round((row.value / (allocatable || 1)) * 100)}% of allocatable
                </span>
              </>,
            )
          }
          onMouseLeave={hide}
          onFocus={(event) =>
            show(
              event,
              <>
                <strong>{row.label}</strong>
                <span>{format(row.value)}</span>
              </>,
            )
          }
          onBlur={hide}
        >
          <span className="viz-capacity-label">{row.label}</span>
          <div className="viz-track viz-track-tall">
            <div className="viz-bar" style={{ width: `${(row.value / max) * 100}%`, background: row.color }} />
            {allocatableOffset < 100 && <span className="viz-rule" style={{ left: `${allocatableOffset}%` }} aria-hidden />}
          </div>
          <span className="viz-capacity-value">{format(row.value)}</span>
        </div>
      ))}
      <div className="viz-capacity-foot">
        <span>Allocatable</span>
        <strong>{format(allocatable)}</strong>
      </div>
      <TooltipLayer tip={tip} />
    </div>
  );
}

/** The one hero figure on the page: a single composite score with its arc. */
export function HealthRing({ score, severity, grade }: { score: number; severity: Severity; grade: string }) {
  const radius = 70;
  const stroke = 12;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(score, 100)) / 100) * circumference;

  return (
    <div className="viz-ring">
      <svg viewBox="0 0 168 168" role="img" aria-label={`Cluster health score ${score} out of 100, ${grade}`}>
        <circle cx="84" cy="84" r={radius} fill="none" stroke="var(--viz-track)" strokeWidth={stroke} />
        <circle
          cx="84"
          cy="84"
          r={radius}
          fill="none"
          stroke={severityVar(severity)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 84 84)"
        />
      </svg>
      <div className="viz-ring-center">
        <strong>{score}</strong>
        <span>/ 100</span>
      </div>
    </div>
  );
}

export function SignalMeter({
  name,
  score,
  severity,
  detail,
  weight,
}: {
  name: string;
  score: number;
  severity: Severity;
  detail: string;
  weight: number;
}) {
  return (
    <div className="viz-signal">
      <div className="viz-signal-head">
        <span>{name}</span>
        <em>weight {weight}</em>
        <strong>{score}</strong>
      </div>
      <div className="viz-track">
        <div className="viz-bar" style={{ width: `${score}%`, background: severityVar(severity) }} />
      </div>
      <p>{detail}</p>
    </div>
  );
}

export function StatTile({
  label,
  value,
  note,
  severity,
}: {
  label: string;
  value: string;
  note?: string;
  severity?: Severity;
}) {
  return (
    <div className="viz-stat">
      <span className="viz-stat-label">{label}</span>
      <strong className="viz-stat-value">{value}</strong>
      <span className="viz-stat-note">
        {severity && <SeverityBadge severity={severity} label={note} />}
        {!severity && note}
      </span>
    </div>
  );
}

/** Every chart ships a table twin so no value is reachable only by colour or hover. */
export function TableToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="viz-toggle" onClick={onToggle} aria-expanded={open}>
      {open ? 'Hide table' : 'Table view'}
    </button>
  );
}

export function DataTable({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
