/**
 * Run Visual Report: MCP App widget for the CJA `runVisualReport` tool.
 *
 * The Java server serves a thin HTML shell containing only `<div id="app">`
 * and a module script pointing at this file. This module builds its own DOM,
 * so the shell never has to change when the widget layout does.
 *
 * The host<->iframe handshake is handled by the official
 * `@modelcontextprotocol/ext-apps` SDK. Never hand-roll it: strict hosts
 * (claude.ai, Claude Desktop) silently reject incomplete handshakes.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Chart,
  LineController,
  BarController,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
} from "chart.js";
// Imported as a string and injected, so the built bundle is a single JS file
// (the server's shell loads only one module script, no stylesheet link).
import widgetCss from "./styles.css?inline";

{
  const style = document.createElement("style");
  style.textContent = widgetCss;
  document.head.appendChild(style);
}

Chart.register(
  LineController,
  BarController,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
);

// ---- DOM ----
function buildDom(): void {
  const mount = document.getElementById("app") ?? document.body;
  mount.innerHTML = `
    <main class="root">
      <header class="report-header" id="report-header" hidden>
        <div class="report-header__main">
          <h1 class="dimension-title" id="dimension-title"></h1>
          <p class="date-range" id="date-range"></p>
        </div>
        <span class="report-badge">Customer Journey Analytics</span>
      </header>
      <p class="status" id="status">Waiting for report data…</p>
      <p class="error" id="error" hidden></p>
      <section class="summary-cards" id="summary-cards" hidden></section>
      <section class="chart-wrap" id="chart-wrap" hidden>
        <canvas id="chart"></canvas>
      </section>
    </main>`;
}
buildDom();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rootEl = document.querySelector(".root") as HTMLElement;
const statusEl = byId<HTMLParagraphElement>("status");
const errorEl = byId<HTMLParagraphElement>("error");
const headerEl = byId<HTMLElement>("report-header");
const dimensionTitleEl = byId<HTMLElement>("dimension-title");
const dateRangeEl = byId<HTMLElement>("date-range");
const summaryEl = byId<HTMLElement>("summary-cards");
const chartWrapEl = byId<HTMLElement>("chart-wrap");
const canvasEl = byId<HTMLCanvasElement>("chart");

let chartInstance: Chart | null = null;

// ---- Palette ----
const PALETTE = ["#5b5fef", "#14b8a6", "#f59e0b", "#ec4899", "#84cc16", "#06b6d4"];

// ---- CJA ranked report payload (plus the input echo added by runVisualReport) ----
interface CjaRow {
  itemId?: string;
  value?: string;
  data?: Array<number | string>;
}

interface CjaPayload {
  error?: string;
  message?: string;
  columns?: {
    dimension?: { id?: string; type?: string };
    columnIds?: string[];
  };
  rows?: CjaRow[];
  summaryData?: { totals?: number[]; filteredTotals?: number[] };
  // Echoed tool inputs
  dimensionId?: string;
  metricIds?: string[];
  startDate?: string;
  endDate?: string;
}

// ---- Friendly labels ----
const METRIC_LABELS: Record<string, string> = {
  occurrences: "Occurrences",
  visits: "Sessions",
  sessions: "Sessions",
  visitors: "People",
  people: "People",
  pageviews: "Page Views",
  bounces: "Bounces",
  bouncerate: "Bounce Rate",
  entries: "Entries",
  exits: "Exits",
  orders: "Orders",
  revenue: "Revenue",
  units: "Units",
  timespent: "Time Spent",
};

const DIMENSION_LABELS: Record<string, string> = {
  daterangeminute: "Minute Trend",
  daterangehour: "Hourly Trend",
  daterangeday: "Daily Trend",
  daterangeweek: "Weekly Trend",
  daterangemonth: "Monthly Trend",
  daterangequarter: "Quarterly Trend",
  daterangeyear: "Yearly Trend",
};

function titleCase(s: string): string {
  return s.replace(/[_\-.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyMetric(id: string): string {
  const stripped = id.replace(/^metrics\//i, "");
  return METRIC_LABELS[stripped.toLowerCase()] ?? titleCase(stripped);
}

function prettyDimension(id: string): string {
  const stripped = id.replace(/^variables\//i, "");
  return DIMENSION_LABELS[stripped.toLowerCase()] ?? titleCase(stripped);
}

// ---- Number formatting ----
const NF_INT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const NF_DEC = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const NF_COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function formatTotal(n: number): string {
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return NF_COMPACT.format(n);
  return Number.isInteger(n) ? NF_INT.format(n) : NF_DEC.format(n);
}

function formatAxis(n: number): string {
  if (!isFinite(n)) return "";
  return Math.abs(n) >= 1000 ? NF_COMPACT.format(n) : NF_DEC.format(n);
}

// ---- Date helpers ----
type Granularity = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";

function granularityOf(dimId: string): Granularity {
  const m = /daterange(minute|hour|day|week|month|quarter|year)/i.exec(dimId);
  return (m?.[1]?.toLowerCase() as Granularity) ?? "day";
}

function tryParseDate(label: string): number {
  const t = Date.parse(label);
  return isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function formatDateLabel(label: string, g: Granularity): string {
  const t = Date.parse(label);
  if (isNaN(t)) return label;
  const d = new Date(t);
  switch (g) {
    case "minute":
    case "hour":
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: g === "minute" ? "2-digit" : undefined });
    case "month":
    case "quarter":
      return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    case "year":
      return String(d.getFullYear());
    default:
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

function formatDateRange(start?: string, end?: string): string {
  if (!start || !end) return "";
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return `${start} → ${end}`;
  const sameYear = s.getFullYear() === e.getFullYear();
  const sFmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `${s.toLocaleDateString(undefined, sFmt)} → ${e.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

// ---- Theme helpers ----
function readCssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.length === 3 ? m[0] + m[0] : m.slice(0, 2), 16);
  const g = parseInt(m.length === 3 ? m[1] + m[1] : m.slice(2, 4), 16);
  const b = parseInt(m.length === 3 ? m[2] + m[2] : m.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(91, 95, 239, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function makeGradient(ctx: CanvasRenderingContext2D, color: string, height: number) {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, hexToRgba(color, 0.32));
  g.addColorStop(1, hexToRgba(color, 0));
  return g;
}

// ---- UI state ----
function setStatus(text: string) {
  statusEl.textContent = text;
  statusEl.hidden = text.length === 0;
}

function setError(text: string) {
  errorEl.textContent = text;
  errorEl.hidden = text.length === 0;
}

function showReady() {
  headerEl.hidden = false;
  summaryEl.hidden = false;
  chartWrapEl.hidden = false;
  statusEl.hidden = true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function renderSummaryCards(labels: string[], totals: number[], rowCount: number, isTime: boolean, g: Granularity) {
  summaryEl.innerHTML = "";
  labels.forEach((label, i) => {
    const total = totals[i] ?? 0;
    const sub = isTime && rowCount > 0 ? `Avg ${formatTotal(total / rowCount)} / ${g}` : `${rowCount} items`;
    const card = document.createElement("div");
    card.className = "summary-card";
    card.style.setProperty("--card-accent", PALETTE[i % PALETTE.length]);
    card.innerHTML = `
      <span class="summary-card__label">${escapeHtml(label)}</span>
      <span class="summary-card__value">${formatTotal(total)}</span>
      <span class="summary-card__sub">${escapeHtml(sub)}</span>`;
    summaryEl.appendChild(card);
  });
}

// ---- Render ----
function renderChart(payload: CjaPayload) {
  setError("");

  if (!payload || typeof payload !== "object") {
    setStatus("");
    setError("No payload received.");
    return;
  }
  if (payload.error) {
    setStatus("");
    setError(`Report error: ${payload.error}`);
    return;
  }

  const dimId = payload.columns?.dimension?.id ?? payload.dimensionId ?? "";
  const dimType = payload.columns?.dimension?.type ?? "";
  const isTime = dimType === "time" || /daterange/i.test(dimId);
  const g = granularityOf(dimId);

  const metricIds: string[] = Array.isArray(payload.metricIds)
    ? payload.metricIds
    : Array.isArray(payload.columns?.columnIds)
      ? payload.columns!.columnIds!
      : ["value"];
  const metricLabels = metricIds.map(prettyMetric);

  let rows: CjaRow[] = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    setStatus("No rows returned.");
    return;
  }

  // Ranked reports sort by the first metric; re-sort time dimensions chronologically.
  if (isTime) {
    rows = [...rows].sort((a, b) => tryParseDate(String(a.value ?? "")) - tryParseDate(String(b.value ?? "")));
  }

  const rawLabels = rows.map((r) => String(r.value ?? r.itemId ?? ""));
  const displayLabels = isTime ? rawLabels.map((l) => formatDateLabel(l, g)) : rawLabels;

  const seriesData: number[][] = metricIds.map((_, mi) =>
    rows.map((r) => {
      const v = (r.data ?? [])[mi];
      return typeof v === "number" ? v : Number(v) || 0;
    }),
  );

  const summaryTotals = payload.summaryData?.totals;
  const totals = metricIds.map((_, mi) =>
    Array.isArray(summaryTotals) && typeof summaryTotals[mi] === "number"
      ? summaryTotals[mi]
      : seriesData[mi].reduce((acc, n) => acc + n, 0),
  );

  dimensionTitleEl.textContent = prettyDimension(dimId);
  dateRangeEl.textContent = formatDateRange(payload.startDate, payload.endDate);

  renderSummaryCards(metricLabels, totals, rows.length, isTime, g);

  const ctx2d = canvasEl.getContext("2d")!;
  const canvasHeight = canvasEl.clientHeight || 360;
  const textColor = readCssVar("--chart-text", "#0f111a");
  const mutedColor = readCssVar("--chart-text-muted", "#5f6573");
  const gridColor = readCssVar("--chart-border", "rgba(15, 17, 26, 0.08)");

  const datasets = metricIds.map((_, mi) => {
    const color = PALETTE[mi % PALETTE.length];
    return {
      label: metricLabels[mi],
      data: seriesData[mi],
      borderColor: color,
      backgroundColor: isTime ? makeGradient(ctx2d, color, canvasHeight) : hexToRgba(color, 0.85),
      borderWidth: 2.25,
      tension: 0.35,
      pointBackgroundColor: color,
      pointBorderColor: color,
      pointBorderWidth: 0,
      pointRadius: rows.length > 60 ? 0 : rows.length > 30 ? 2 : 3,
      pointHoverRadius: 6,
      pointHoverBorderWidth: 2,
      pointHoverBackgroundColor: "#ffffff",
      pointHoverBorderColor: color,
      fill: isTime ? "origin" : false,
      borderRadius: isTime ? 0 : 6,
    };
  });

  chartInstance?.destroy();
  chartInstance = null;

  try {
    chartInstance = new Chart(ctx2d, {
      type: isTime ? "line" : "bar",
      data: { labels: displayLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        animation: { duration: 600, easing: "easeOutQuart" },
        layout: { padding: { top: 6, right: 4, bottom: 0, left: 0 } },
        plugins: {
          legend: {
            position: "bottom",
            align: "start",
            labels: {
              boxWidth: 10,
              boxHeight: 10,
              useBorderRadius: true,
              borderRadius: 3,
              color: textColor,
              font: { size: 12, family: readCssVar("--chart-font", "sans-serif") },
              padding: 14,
            },
          },
          tooltip: {
            backgroundColor: readCssVar("--chart-surface", "#ffffff"),
            titleColor: textColor,
            bodyColor: textColor,
            borderColor: gridColor,
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            usePointStyle: true,
            boxPadding: 4,
            titleFont: { size: 12, weight: "bold" },
            bodyFont: { size: 12 },
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${NF_DEC.format(Number(ctx.parsed.y) || 0)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: gridColor },
            ticks: { color: mutedColor, font: { size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 },
          },
          y: {
            beginAtZero: true,
            grid: { color: gridColor },
            border: { display: false },
            ticks: { color: mutedColor, font: { size: 11 }, callback: (v) => formatAxis(Number(v)) },
          },
        },
      },
    });
  } catch (e) {
    setError(`Render error: ${(e as Error).message}`);
    return;
  }

  showReady();
}

function extractPayload(result: CallToolResult): CjaPayload {
  const first = result.content?.[0];
  const text = first && first.type === "text" && typeof first.text === "string" ? first.text : undefined;

  if (result.isError) {
    return { error: text ?? "The tool returned an error." };
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as CjaPayload;
  }
  if (text) {
    try {
      return JSON.parse(text) as CjaPayload;
    } catch {
      return { error: "Tool result was not JSON (was compressed output enabled?)." };
    }
  }
  return { error: "Tool result contained no payload." };
}

function handleHostContextChanged(ctx: McpUiHostContext) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    rootEl.style.padding = `${top + 20}px ${right + 22}px ${bottom + 20}px ${left + 22}px`;
  }
}

// ---- App wiring: register ALL handlers before connect() ----
const app = new App({ name: "cja-run-visual-report", version: "0.1.0" });

app.onteardown = async () => {
  chartInstance?.destroy();
  chartInstance = null;
  return {};
};

app.ontoolinput = () => {
  setStatus("Running report…");
  setError("");
};

app.ontoolresult = (result) => renderChart(extractPayload(result));

app.ontoolcancelled = (params) => {
  setStatus("");
  setError(`Tool cancelled: ${params.reason}`);
};

app.onerror = (err) => console.error("[run-visual-report]", err);

app.onhostcontextchanged = handleHostContextChanged;

await app.connect();

// Apply whatever context the host sent during the handshake.
const initialCtx = app.getHostContext?.();
if (initialCtx) handleHostContextChanged(initialCtx);
