import { jsPDF } from 'jspdf';
import { ENVIRONMENT_INK, PAPER, SERIES, rgb, severityInk } from './report-theme';
import { formatBytes, formatCount, formatCpu, formatPercent, percent } from './format';
import type { ClusterOverview } from '../types/cluster';
import type { EnvironmentId } from '../types/settings';

const PAGE = { width: 210, height: 297, margin: 16 };
const CONTENT = PAGE.width - PAGE.margin * 2;
/** Everything below this belongs to the footer; content must never reach it. */
const FOOTER_TOP = PAGE.height - 20;

/** Starts a new page when the next block would run into the footer. */
function ensureRoom(pdf: jsPDF, y: number, needed: number): number {
  if (y + needed <= FOOTER_TOP) return y;
  pdf.addPage();
  return PAGE.margin + 4;
}

/**
 * Builds the executive report.
 *
 * Drawn as vectors rather than captured from the screen: text stays selectable and
 * searchable, the file stays small, and the layout is free to differ from the console.
 * The console is read by an operator at 1440px with hover and table toggles; this is
 * read on A4 with none of that, so it carries the same data at a different density.
 */
export function buildClusterReport(data: ClusterOverview, environment: EnvironmentId): jsPDF {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  pdf.setFont('helvetica', 'normal');

  const name = clusterDisplayName(data);
  let y = drawHeader(pdf, data, name, environment);

  y = drawVerdict(pdf, data, y + 5);
  y = drawKpis(pdf, data, y + 6);
  y = drawSignals(pdf, data, y + 6);
  drawCapacity(pdf, data, y + 6);

  pdf.addPage();
  let second = drawSectionTitle(pdf, 'What needs attention', PAGE.margin + 4);
  second = drawFindings(pdf, data, second + 2);
  second = drawFleet(pdf, data, second + 6);
  drawNodes(pdf, data, second + 6);

  stampFooters(pdf, data, name);
  return pdf;
}

/** `arn:aws:eks:…:cluster/prod-shark` and `prod-shark` both become `prod-shark`. */
export function clusterDisplayName(data: ClusterOverview): string {
  const explicit = data.control_plane.cluster_name?.trim();
  if (explicit) return explicit;
  const tail = data.context.split('/').pop()?.trim();
  return tail && tail.length > 0 ? tail : data.context;
}

export function reportFileName(data: ClusterOverview): string {
  return `Executive Report - ${clusterDisplayName(data)}`;
}

// ---------------------------------------------------------------- primitives

function setFill(pdf: jsPDF, hex: string) {
  const [r, g, b] = rgb(hex);
  pdf.setFillColor(r, g, b);
}

function setInk(pdf: jsPDF, hex: string) {
  const [r, g, b] = rgb(hex);
  pdf.setTextColor(r, g, b);
}

function setStroke(pdf: jsPDF, hex: string) {
  const [r, g, b] = rgb(hex);
  pdf.setDrawColor(r, g, b);
}

function text(pdf: jsPDF, value: string, x: number, y: number, size: number, ink: string, bold = false) {
  pdf.setFont('helvetica', bold ? 'bold' : 'normal');
  pdf.setFontSize(size);
  setInk(pdf, ink);
  pdf.text(value, x, y);
}

/** Truncates to a measured width so a label can never overflow its column. */
function clip(pdf: jsPDF, value: string, size: number, maxWidth: number): string {
  pdf.setFontSize(size);
  if (pdf.getTextWidth(value) <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && pdf.getTextWidth(`${cut}…`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Bars grow from a single baseline with a rounded data end, as on screen. */
function bar(pdf: jsPDF, x: number, y: number, width: number, height: number, hex: string) {
  if (width <= 0) return;
  setFill(pdf, hex);
  pdf.roundedRect(x, y, Math.max(width, 0.6), height, Math.min(height / 2, 0.8), Math.min(height / 2, 0.8), 'F');
}

function track(pdf: jsPDF, x: number, y: number, width: number, height: number) {
  setFill(pdf, PAPER.rule);
  pdf.roundedRect(x, y, width, height, height / 2, height / 2, 'F');
}

function panel(pdf: jsPDF, x: number, y: number, width: number, height: number) {
  setFill(pdf, PAPER.panel);
  setStroke(pdf, PAPER.rule);
  pdf.setLineWidth(0.2);
  pdf.roundedRect(x, y, width, height, 1.6, 1.6, 'FD');
}

/** Severity always travels with its word — the ink alone is never the signal. */
function severityChip(pdf: jsPDF, label: string, x: number, y: number, severity: string) {
  const ink = severityInk(severity);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'bold');
  const width = pdf.getTextWidth(label.toUpperCase()) + 4;
  setFill(pdf, ink);
  pdf.roundedRect(x, y - 3, width, 4.4, 0.8, 0.8, 'F');
  setInk(pdf, '#ffffff');
  pdf.text(label.toUpperCase(), x + 2, y);
  return width;
}

// ---------------------------------------------------------------- sections

function drawHeader(pdf: jsPDF, data: ClusterOverview, name: string, environment: EnvironmentId): number {
  const y = PAGE.margin;
  text(pdf, 'EXECUTIVE REPORT', PAGE.margin, y, 8, PAPER.muted, true);
  text(pdf, name, PAGE.margin, y + 9, 21, PAPER.ink, true);

  const generated = new Date(data.generated_at);
  const stamp = Number.isNaN(generated.getTime()) ? '—' : generated.toLocaleString();
  text(pdf, `${data.control_plane.distribution} · Kubernetes ${data.control_plane.kubernetes_version}`, PAGE.margin, y + 15.5, 9, PAPER.inkSecondary);
  text(pdf, `Generated ${stamp}`, PAGE.margin, y + 20, 8, PAPER.muted);

  if (environment !== 'unset') {
    const label = environment.toUpperCase();
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    const width = pdf.getTextWidth(label) + 6;
    setFill(pdf, ENVIRONMENT_INK[environment]);
    pdf.roundedRect(PAGE.width - PAGE.margin - width, y - 4, width, 6, 1, 1, 'F');
    setInk(pdf, '#ffffff');
    pdf.text(label, PAGE.width - PAGE.margin - width + 3, y);
  }

  setStroke(pdf, PAPER.baseline);
  pdf.setLineWidth(0.3);
  pdf.line(PAGE.margin, y + 24, PAGE.width - PAGE.margin, y + 24);
  return y + 24;
}

/** The one hero figure: a ring gauge with the score inside it. */
function drawVerdict(pdf: jsPDF, data: ClusterOverview, y: number): number {
  const height = 31;
  panel(pdf, PAGE.margin, y, CONTENT, height);

  const severity = gradeSeverity(data.health.score);
  const centreX = PAGE.margin + 20;
  const centreY = y + height / 2;
  drawGauge(pdf, centreX, centreY, 13, data.health.score, severityInk(severity));

  const textX = PAGE.margin + 40;
  text(pdf, data.health.grade, textX, y + 11, 15, severityInk(severity), true);
  const headline = pdf.splitTextToSize(data.health.headline, CONTENT - 48) as string[];
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  setInk(pdf, PAPER.inkSecondary);
  pdf.text(headline.slice(0, 2), textX, y + 17);

  text(
    pdf,
    `Composite of ${data.health.signals.length} weighted signals. Every figure below is read from the cluster; nothing is estimated.`,
    textX,
    y + height - 4.5,
    7.5,
    PAPER.muted,
  );
  return y + height;
}

function drawGauge(pdf: jsPDF, cx: number, cy: number, radius: number, score: number, hex: string) {
  const thickness = 3.4;
  setStroke(pdf, PAPER.rule);
  pdf.setLineWidth(thickness);
  pdf.circle(cx, cy, radius, 'S');

  // jsPDF has no arc primitive, so the filled portion is stroked as short segments.
  const fraction = Math.max(0, Math.min(score, 100)) / 100;
  const steps = Math.max(1, Math.round(fraction * 72));
  setStroke(pdf, hex);
  pdf.setLineWidth(thickness);
  pdf.setLineCap('round');
  for (let index = 0; index < steps; index += 1) {
    const from = -Math.PI / 2 + (index / 72) * Math.PI * 2;
    const to = -Math.PI / 2 + ((index + 1) / 72) * Math.PI * 2;
    pdf.line(cx + radius * Math.cos(from), cy + radius * Math.sin(from), cx + radius * Math.cos(to), cy + radius * Math.sin(to));
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  setInk(pdf, PAPER.ink);
  pdf.text(String(score), cx, cy + 1.5, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6);
  setInk(pdf, PAPER.muted);
  pdf.text('/ 100', cx, cy + 5.5, { align: 'center' });
}

function drawKpis(pdf: jsPDF, data: ClusterOverview, y: number): number {
  const { nodes, pods, capacity, workloads, events } = data;
  const ready = nodes.filter((node) => node.ready).length;
  const degraded = workloads.deployments.degraded + workloads.statefulsets.degraded + workloads.daemonsets.degraded;
  const total = workloads.deployments.total + workloads.statefulsets.total + workloads.daemonsets.total;

  const tiles = [
    { label: 'Nodes ready', value: `${ready}/${nodes.length}`, note: ready === nodes.length ? 'All ready' : `${nodes.length - ready} not ready` },
    { label: 'Pods ready', value: `${formatCount(pods.ready)}/${formatCount(pods.total - pods.succeeded)}`, note: `${formatCount(pods.total)} total` },
    { label: 'CPU reserved', value: formatPercent(percent(capacity.cpu.requested, capacity.cpu.allocatable)), note: `of ${formatCpu(capacity.cpu.allocatable)}` },
    { label: 'Memory reserved', value: formatPercent(percent(capacity.memory.requested, capacity.memory.allocatable)), note: `of ${formatBytes(capacity.memory.allocatable)}` },
    { label: 'Degraded workloads', value: `${degraded}/${total}`, note: degraded === 0 ? 'At desired replicas' : 'Below desired' },
    { label: 'Warning events', value: formatCount(events.warning_count), note: events.truncated ? 'capped at 500' : 'cluster-wide' },
  ];

  const gap = 3;
  const width = (CONTENT - gap * 2) / 3;
  const height = 17;

  tiles.forEach((tile, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = PAGE.margin + column * (width + gap);
    const top = y + row * (height + gap);
    panel(pdf, x, top, width, height);
    text(pdf, tile.label, x + 4, top + 5.5, 7, PAPER.muted);
    text(pdf, tile.value, x + 4, top + 12.5, 14, PAPER.ink, true);
    text(pdf, clip(pdf, tile.note, 6.5, width - 8), x + 4, top + 16, 6.5, PAPER.muted);
  });

  return y + height * 2 + gap;
}

function drawSignals(pdf: jsPDF, data: ClusterOverview, y: number): number {
  let cursor = drawSectionTitle(pdf, 'Health signals', y);
  const rowHeight = 9.8;

  data.health.signals.forEach((signal) => {
    cursor = ensureRoom(pdf, cursor, rowHeight);
    text(pdf, signal.name, PAGE.margin, cursor + 3, 8.5, PAPER.ink, true);
    text(pdf, `weight ${signal.weight}`, PAGE.margin + 46, cursor + 3, 7, PAPER.muted);

    const barX = PAGE.margin + 66;
    const barWidth = CONTENT - 66 - 12;
    track(pdf, barX, cursor, barWidth, 2.6);
    bar(pdf, barX, cursor, (barWidth * signal.score) / 100, 2.6, severityInk(signal.severity));

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    setInk(pdf, PAPER.ink);
    pdf.text(String(signal.score), PAGE.width - PAGE.margin, cursor + 2.6, { align: 'right' });

    text(pdf, clip(pdf, signal.detail, 7, CONTENT - 66), barX, cursor + 6.6, 7, PAPER.muted);
    cursor += rowHeight;
  });

  return cursor;
}

function drawCapacity(pdf: jsPDF, data: ClusterOverview, y: number): number {
  let cursor = drawSectionTitle(pdf, 'Capacity', y);
  text(
    pdf,
    'Requests reserve capacity whether or not it is consumed, so they — not live usage — are what stops new workloads from scheduling.',
    PAGE.margin,
    cursor + 3.5,
    7.5,
    PAPER.muted,
  );
  cursor += 8;

  cursor = drawCapacityAxis(pdf, 'CPU', ensureRoom(pdf, cursor, 26), data.capacity.cpu, formatCpu);
  cursor = drawCapacityAxis(pdf, 'Memory', ensureRoom(pdf, cursor + 4, 26), data.capacity.memory, formatBytes);
  return cursor;
}

function drawCapacityAxis(
  pdf: jsPDF,
  title: string,
  y: number,
  axis: { allocatable: number; requested: number; limits: number; used?: number },
  format: (value: number) => string,
): number {
  text(pdf, title, PAGE.margin, y + 3, 8, PAPER.ink, true);
  let cursor = y + 6;

  const rows = [
    ...(axis.used !== undefined ? [{ label: 'Live usage', value: axis.used, hex: SERIES.used }] : []),
    { label: 'Requested', value: axis.requested, hex: SERIES.requested },
    { label: 'Limits', value: axis.limits, hex: SERIES.limits },
  ];
  const max = Math.max(axis.allocatable, ...rows.map((row) => row.value)) || 1;
  const barX = PAGE.margin + 26;
  const barWidth = CONTENT - 26 - 26;

  rows.forEach((row) => {
    text(pdf, row.label, PAGE.margin, cursor + 2.4, 7.5, PAPER.inkSecondary);
    track(pdf, barX, cursor, barWidth, 3);
    bar(pdf, barX, cursor, (barWidth * row.value) / max, 3, row.hex);
    pdf.setFontSize(7.5);
    pdf.setFont('helvetica', 'normal');
    setInk(pdf, PAPER.ink);
    pdf.text(format(row.value), PAGE.width - PAGE.margin, cursor + 2.4, { align: 'right' });
    cursor += 5.5;
  });

  // The allocatable rule: a bar past it is capacity promised beyond what exists.
  const ruleX = barX + (barWidth * axis.allocatable) / max;
  setStroke(pdf, PAPER.baseline);
  pdf.setLineWidth(0.4);
  pdf.line(ruleX, y + 5, ruleX, cursor - 2);
  text(pdf, `Allocatable ${format(axis.allocatable)}`, barX, cursor + 1.5, 6.5, PAPER.muted);
  return cursor + 3;
}

function drawSectionTitle(pdf: jsPDF, title: string, y: number): number {
  text(pdf, title.toUpperCase(), PAGE.margin, y, 8, PAPER.ink, true);
  setStroke(pdf, PAPER.rule);
  pdf.setLineWidth(0.3);
  pdf.line(PAGE.margin, y + 1.8, PAGE.width - PAGE.margin, y + 1.8);
  return y + 6;
}

function drawFindings(pdf: jsPDF, data: ClusterOverview, y: number): number {
  let cursor = y;

  data.findings.slice(0, 6).forEach((finding) => {
    const detail = pdf.splitTextToSize(finding.detail, CONTENT - 6) as string[];
    const targets = finding.targets.slice(0, 3);
    const height = 11 + detail.length * 3.6 + targets.length * 3.4 + 5;

    if (cursor + height > PAGE.height - 24) {
      pdf.addPage();
      cursor = PAGE.margin + 6;
    }

    setFill(pdf, severityInk(finding.severity));
    pdf.rect(PAGE.margin, cursor, 0.9, height - 3, 'F');

    const chipWidth = severityChip(pdf, finding.severity, PAGE.margin + 3.5, cursor + 4, finding.severity);
    text(pdf, clip(pdf, finding.title, 9.5, CONTENT - chipWidth - 12), PAGE.margin + 5.5 + chipWidth, cursor + 4, 9.5, PAPER.ink, true);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.8);
    setInk(pdf, PAPER.inkSecondary);
    pdf.text(detail, PAGE.margin + 3.5, cursor + 9);

    let line = cursor + 9 + detail.length * 3.6;
    targets.forEach((target) => {
      text(pdf, `• ${clip(pdf, target, 7, CONTENT - 10)}`, PAGE.margin + 3.5, line, 7, PAPER.muted);
      line += 3.4;
    });
    if (finding.targets.length > targets.length) {
      text(pdf, `• and ${finding.targets.length - targets.length} more`, PAGE.margin + 3.5, line, 7, PAPER.muted);
      line += 3.4;
    }

    text(pdf, clip(pdf, finding.hint, 7, CONTENT - 10), PAGE.margin + 3.5, line + 1, 7, PAPER.inkSecondary);
    cursor += height;
  });

  return cursor;
}

function drawFleet(pdf: jsPDF, data: ClusterOverview, y: number): number {
  if (y > PAGE.height - 70) {
    pdf.addPage();
    y = PAGE.margin + 6;
  }
  let cursor = drawSectionTitle(pdf, 'Fleet', y);

  const zones = data.distribution.zones;
  if (zones.length > 0) {
    text(pdf, 'Nodes per availability zone', PAGE.margin, cursor + 3, 7.5, PAPER.muted);
    cursor += 6;
    const max = Math.max(...zones.map((zone) => zone.nodes), 1);
    const barX = PAGE.margin + 30;
    const barWidth = CONTENT - 30 - 18;

    zones.forEach((zone) => {
      text(pdf, clip(pdf, zone.zone, 7.5, 28), PAGE.margin, cursor + 2.4, 7.5, PAPER.inkSecondary);
      track(pdf, barX, cursor, barWidth, 3);
      const ratio = zone.nodes / max;
      // Ready and not-ready are stacked, separated by the surface rather than a stroke.
      const readyWidth = (barWidth * ratio * zone.ready_nodes) / Math.max(zone.nodes, 1);
      bar(pdf, barX, cursor, readyWidth, 3, STATUS_GOOD);
      const failing = zone.nodes - zone.ready_nodes;
      if (failing > 0) {
        bar(pdf, barX + readyWidth + 0.6, cursor, (barWidth * ratio * failing) / zone.nodes - 0.6, 3, STATUS_CRITICAL);
      }
      pdf.setFontSize(7.5);
      setInk(pdf, PAPER.ink);
      pdf.text(`${zone.ready_nodes}/${zone.nodes}`, PAGE.width - PAGE.margin, cursor + 2.4, { align: 'right' });
      cursor += 5;
    });
    text(pdf, 'Green: ready.  Red: not ready.', PAGE.margin, cursor + 1.5, 6.5, PAPER.muted);
    cursor += 5;
  }

  const columns: { title: string; entries: { label: string; value: number }[] }[] = [
    { title: 'Capacity type', entries: data.distribution.capacity_types },
    { title: 'Instance type', entries: data.distribution.instance_types.slice(0, 5) },
    { title: 'Node pool', entries: data.distribution.node_pools.slice(0, 5) },
  ];

  const gap = 4;
  const width = (CONTENT - gap * 2) / 3;
  let deepest = cursor;

  columns.forEach((column, index) => {
    if (column.entries.length === 0) return;
    const x = PAGE.margin + index * (width + gap);
    text(pdf, column.title, x, cursor + 4, 7.5, PAPER.muted, true);
    let line = cursor + 8;
    column.entries.forEach((entry) => {
      text(pdf, clip(pdf, entry.label, 7, width - 10), x, line, 7, PAPER.inkSecondary);
      pdf.setFontSize(7);
      setInk(pdf, PAPER.ink);
      pdf.text(String(entry.value), x + width - 2, line, { align: 'right' });
      line += 4;
    });
    deepest = Math.max(deepest, line);
  });

  return deepest;
}

const STATUS_GOOD = '#0ca30c';
const STATUS_CRITICAL = '#d03b3b';

function drawNodes(pdf: jsPDF, data: ClusterOverview, y: number): number {
  const nodes = [...data.nodes]
    .sort((left, right) => percent(right.cpu_requested_milli, right.cpu_allocatable_milli) - percent(left.cpu_requested_milli, left.cpu_allocatable_milli))
    .slice(0, 12);
  if (nodes.length === 0) return y;

  if (y > PAGE.height - 60) {
    pdf.addPage();
    y = PAGE.margin + 6;
  }
  let cursor = drawSectionTitle(pdf, 'Nodes by reserved CPU', y);

  const columns = [
    { label: 'Node', x: PAGE.margin, width: 62 },
    { label: 'Zone', x: PAGE.margin + 64, width: 26 },
    { label: 'CPU req', x: PAGE.margin + 92, width: 20 },
    { label: 'Mem req', x: PAGE.margin + 114, width: 20 },
    { label: 'Pods', x: PAGE.margin + 136, width: 14 },
    { label: 'State', x: PAGE.margin + 152, width: 26 },
  ];

  columns.forEach((column) => text(pdf, column.label.toUpperCase(), column.x, cursor + 2, 6, PAPER.muted, true));
  cursor += 4;
  setStroke(pdf, PAPER.rule);
  pdf.setLineWidth(0.2);
  pdf.line(PAGE.margin, cursor, PAGE.width - PAGE.margin, cursor);
  cursor += 4;

  nodes.forEach((node) => {
    text(pdf, clip(pdf, node.name.split('.')[0], 7, columns[0].width), columns[0].x, cursor, 7, PAPER.ink);
    text(pdf, clip(pdf, node.zone, 7, columns[1].width), columns[1].x, cursor, 7, PAPER.inkSecondary);
    text(pdf, formatPercent(percent(node.cpu_requested_milli, node.cpu_allocatable_milli)), columns[2].x, cursor, 7, PAPER.inkSecondary);
    text(pdf, formatPercent(percent(node.memory_requested_bytes, node.memory_allocatable_bytes)), columns[3].x, cursor, 7, PAPER.inkSecondary);
    text(pdf, String(node.pod_count), columns[4].x, cursor, 7, PAPER.inkSecondary);

    const state = !node.ready ? 'Not ready' : node.pressure ? 'Pressure' : node.unschedulable ? 'Cordoned' : 'Ready';
    text(pdf, state, columns[5].x, cursor, 7, severityInk(node.health), state !== 'Ready');
    cursor += 4.4;
  });

  return cursor;
}

function stampFooters(pdf: jsPDF, data: ClusterOverview, name: string) {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    setStroke(pdf, PAPER.rule);
    pdf.setLineWidth(0.2);
    pdf.line(PAGE.margin, PAGE.height - 14, PAGE.width - PAGE.margin, PAGE.height - 14);

    text(pdf, `tmjLens · ${name}`, PAGE.margin, PAGE.height - 10, 6.5, PAPER.muted);
    pdf.setFontSize(6.5);
    setInk(pdf, PAPER.muted);
    pdf.text(`${page} / ${pages}`, PAGE.width - PAGE.margin, PAGE.height - 10, { align: 'right' });

    if (data.degraded_collectors.length > 0) {
      text(
        pdf,
        'Partial: some data could not be collected. See the console for details.',
        PAGE.margin,
        PAGE.height - 6.5,
        6,
        PAPER.muted,
      );
    } else {
      text(pdf, 'Figures reflect what the reporting identity is permitted to read.', PAGE.margin, PAGE.height - 6.5, 6, PAPER.muted);
    }
  }
}

function gradeSeverity(score: number): string {
  if (score >= 90) return 'good';
  if (score >= 75) return 'warning';
  if (score >= 50) return 'serious';
  return 'critical';
}
