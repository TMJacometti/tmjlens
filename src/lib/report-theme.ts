/**
 * Print palette for the executive report.
 *
 * The app is dark; the report is not. A PDF gets printed and read on paper, where a
 * dark theme wastes toner and loses the light categorical steps entirely. These are
 * the light-surface steps of the same validated palette, so the report is recognisably
 * the same system without inheriting a screen-only decision.
 *
 * On a light surface `warning` and `serious` fall below 3:1. Every severity in the
 * report is therefore printed with its word next to the mark, never colour alone.
 */
export const PAPER = {
  surface: '#ffffff',
  panel: '#f7f7f5',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  rule: '#e1e0d9',
  baseline: '#c3c2b7',
} as const;

export const SERIES = {
  used: '#2a78d6',
  requested: '#eb6834',
  limits: '#1baf7a',
} as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const ENVIRONMENT_INK: Record<string, string> = {
  production: '#c4362f',
  staging: '#b57a10',
  development: '#2a78d6',
  unset: '#898781',
};

export type Severity = keyof typeof STATUS;

export function severityInk(severity: string): string {
  return STATUS[severity as Severity] ?? PAPER.muted;
}

/** jsPDF takes RGB triples, not hex. */
export function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}
