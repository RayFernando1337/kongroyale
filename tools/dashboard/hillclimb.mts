// Hill climb: the CPU, power and smoothness tracker from the rendering roadmap (RAY-237). hillclimb.json holds every
// point, one per merged step or release, in the order they landed; this module validates it, and draws one plain SVG
// chart per metric for the front page. hillclimb-add.mts appends a point from a PR or a release gate. Colours come from
// the CSS variables in style.css, so the charts follow the light and dark themes.
import fs from "node:fs";

/** measured: read on a real machine. estimate: expected from a profile or model, not measured. target: where a phase aims. */
export type HillKind = "measured" | "estimate" | "target";
/** One reading of one series at one step. A "state" metric (thermal) carries state instead of value. */
export type HillPoint = { metric: string; series: string; at: string; value?: number; low?: number; high?: number; state?: string; kind: HillKind; pr?: number; release?: string; build: string; date: string; n: number; method: string; source: string; note?: string };
/** A line on a metric's chart: one machine and scene, or one power rail. */
export type HillSeries = { label: string; machine: string };
/** One chart. lower says which way is better; budget draws a line, reference a shaded band (plain three.js, say). */
export type HillMetric = { label: string; unit: string; plain: string; lower: boolean; state?: boolean; budget?: { value: number; label: string }; reference?: { low: number; high: number; label: string; source: string }; series: Record<string, HillSeries>; pending?: string };
export type Hill = { about: string[]; plain: string; metrics: Record<string, HillMetric>; points: HillPoint[] };

export const HILL_KINDS: HillKind[] = ["measured", "estimate", "target"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws when a point names an unknown metric or series, or lacks its kind, build, run count, method, source or date. */
export function checkHill(h: Hill): Hill {
  h.points.forEach((p, i) => {
    const where = "hillclimb.json points[" + i + "] (" + p.metric + "/" + p.series + " at " + p.at + ")";
    const fail = (what: string) => {
      throw new Error(where + ": " + what);
    };
    const m = h.metrics[p.metric];
    if (!m) fail("unknown metric; add it under metrics first");
    if (!m.series[p.series]) fail("unknown series for " + p.metric);
    if (!HILL_KINDS.includes(p.kind)) fail("kind must be one of " + HILL_KINDS.join(", "));
    if (m.state ? !p.state : !Number.isFinite(p.value)) fail(m.state ? "needs a state" : "needs a numeric value");
    if ((p.low === undefined) !== (p.high === undefined)) fail("low and high go together");
    if (!p.at || !p.build || !p.method || !p.source) fail("needs at, build, method and source");
    if (!DATE.test(p.date)) fail("date must be YYYY-MM-DD");
    if (!Number.isInteger(p.n) || p.n < 0) fail("n is the run count (0 for an estimate or a target)");
    if (p.kind === "measured" && p.n < 1) fail("a measured point needs n of at least 1");
  });
  return h;
}

export function readHill(file: string): Hill {
  return checkHill(JSON.parse(fs.readFileSync(file, "utf8")) as Hill);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** One metric's chart: x is the step (in the order points landed), y the value; estimates hollow, targets as diamonds. */
export function renderHillChart(id: string, m: HillMetric, points: HillPoint[]): string {
  const pts = points.filter((p) => p.metric === id && p.value !== undefined);
  const steps = [...new Set(pts.map((p) => p.at))];
  const seriesIds = Object.keys(m.series);
  const vals = pts.flatMap((p) => [p.value as number, p.low ?? (p.value as number), p.high ?? (p.value as number)]).concat(m.budget ? [m.budget.value] : [], m.reference ? [m.reference.low, m.reference.high] : []);
  const raw = (Math.max(...vals) * 1.1) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const tick = ([1, 2, 2.5, 5, 10].find((f) => f * mag >= raw) as number) * mag;
  const top = tick * 4;
  const W = 520;
  const H = 230;
  const L = 40;
  const R = 56;
  const T = 16;
  const B = 56;
  const x = (i: number) => L + (steps.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (steps.length - 1));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const ticks = [0, 1, 2, 3, 4].map((f) => f * tick);
  const title = m.label + " (" + m.unit + "): " + pts.map((p) => m.series[p.series].label + " at " + p.at + " " + fmt(p.value as number) + " " + m.unit + " (" + p.kind + ")").join("; ");
  let svg = '<svg class="hchart" viewBox="0 0 ' + W + " " + H + '" aria-label="' + esc(title) + '"><title>' + esc(title) + "</title>";
  svg += ticks.map((t) => '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y(t) + 4).toFixed(1) + '" text-anchor="end">' + fmt(t) + "</text>").join("");
  if (m.reference) svg += '<rect class="ref" x="' + L + '" width="' + (W - L - R) + '" y="' + y(m.reference.high).toFixed(1) + '" height="' + Math.max(2, y(m.reference.low) - y(m.reference.high)).toFixed(1) + '"/><text class="reflabel" x="' + (W - R - 4) + '" y="' + (y(m.reference.high) - 4).toFixed(1) + '" text-anchor="end">' + esc(m.reference.label) + "</text>";
  if (m.budget) svg += '<line class="budget" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(m.budget.value).toFixed(1) + '" y2="' + y(m.budget.value).toFixed(1) + '"/><text class="budgetlabel" x="' + (W - R - 4) + '" y="' + (y(m.budget.value) - 4).toFixed(1) + '" text-anchor="end">' + esc(m.budget.label + " " + fmt(m.budget.value) + " " + m.unit) + "</text>";
  svg += steps.map((s, i) => '<text class="ax step" x="' + x(i).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="' + (steps.length > 1 && i === steps.length - 1 ? "end" : steps.length > 1 && i === 0 ? "start" : "middle") + '">' + esc(s) + "</text>").join("");
  seriesIds.forEach((sid, si) => {
    const line = pts.filter((p) => p.series === sid);
    const solid = line.filter((p) => p.kind === "measured");
    if (solid.length > 1) svg += '<polyline class="hl h' + si + '" points="' + solid.map((p) => x(steps.indexOf(p.at)).toFixed(1) + "," + y(p.value as number).toFixed(1)).join(" ") + '"/>';
    for (const p of line) {
      const cx = x(steps.indexOf(p.at));
      const cy = y(p.value as number);
      const tip = "<title>" + esc(m.series[sid].label + ", " + p.at + ": " + fmt(p.value as number) + " " + m.unit + (p.low !== undefined ? " (" + fmt(p.low) + "–" + fmt(p.high as number) + ")" : "") + ", " + p.kind + (p.pr ? ", PR #" + p.pr : "") + (p.release ? ", " + p.release : "")) + "</title>";
      if (p.low !== undefined) svg += '<line class="hr h' + si + " k-" + p.kind + '" x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + y(p.low).toFixed(1) + '" y2="' + y(p.high as number).toFixed(1) + '"/>';
      svg += p.kind === "target"
        ? '<rect class="hp h' + si + ' k-target" x="' + (cx - 5).toFixed(1) + '" y="' + (cy - 5).toFixed(1) + '" width="10" height="10" transform="rotate(45 ' + cx.toFixed(1) + " " + cy.toFixed(1) + ')">' + tip + "</rect>"
        : '<circle class="hp h' + si + " k-" + p.kind + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="5">' + tip + "</circle>";
      svg += '<text class="hv h' + si + '" x="' + (cx + 9).toFixed(1) + '" y="' + (cy + 4).toFixed(1) + '">' + fmt(p.value as number) + "</text>";
    }
  });
  return svg + "</svg>";
}
