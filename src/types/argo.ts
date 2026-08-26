import type { Severity } from './cluster';

export type ImageSlot = {
  template: string;
  /** "main" for a container or script step; the member's name inside a containerSet. */
  container: string;
  image: string;
};

export type WorkflowRow = {
  name: string;
  namespace: string;
  phase: string;
  health: Severity;
  reason: string;
  progress: string | null;
  started_at: string | null;
  duration: string | null;
  from_template: string | null;
  age: string;
};

export type CronRow = {
  name: string;
  namespace: string;
  schedule: string;
  suspended: boolean;
  health: Severity;
  reason: string;
  last_scheduled: string | null;
  images: ImageSlot[];
  age: string;
};

export type TemplateRow = {
  name: string;
  namespace: string;
  entrypoint: string;
  images: ImageSlot[];
  age: string;
};

export type ArgoOverview = {
  installed: boolean;
  reason: string | null;
  workflows: WorkflowRow[];
  cron_workflows: CronRow[];
  templates: TemplateRow[];
  degraded_collectors: string[];
};

export const ARGO_VIEWS = ['Runs', 'Cron workflows', 'Templates'] as const;
export type ArgoView = (typeof ARGO_VIEWS)[number];

export function argoViewCount(data: ArgoOverview, view: ArgoView): number {
  if (view === 'Runs') return data.workflows.length;
  if (view === 'Cron workflows') return data.cron_workflows.length;
  return data.templates.length;
}

/** The distinct images a definition runs, for the table cell. */
export function summariseImages(slots: ImageSlot[]): string {
  const unique = [...new Set(slots.map((slot) => slot.image))];
  if (unique.length === 0) return '—';
  if (unique.length <= 2) return unique.map(shortImageRef).join(', ');
  return `${shortImageRef(unique[0])} and ${unique.length - 1} more`;
}

/** Registry paths repeat across a cluster; the repo and tag are what differ. */
export function shortImageRef(image: string): string {
  return image.includes('/') ? image.slice(image.lastIndexOf('/') + 1) : image;
}

/** Where a slot lives, phrased for a label: "build" or "publish · sign". */
export function slotLabel(slot: ImageSlot): string {
  return slot.container === 'main' ? slot.template : `${slot.template} · ${slot.container}`;
}
