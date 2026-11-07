// Front page: Ray's update in his own words, with every claim backed by a number, its kind (measured, model or
// estimate), its source and its date. Reads front.json for the hand-kept numbers and takes the live counts (PRs per
// day, lines changed, checks, upstream) from build.mts. Charts are plain HTML bars and inline SVG coloured by the CSS
// variables in style.css, so they follow the light and dark themes and need no chart library.
import fs from "node:fs";
import { renderHillChart } from "./hillclimb.mts";
import type { Hill, HillMetric } from "./hillclimb.mts";

export type Kind = "measured" | "model" | "estimate";
type Win = { id: string; head: string; before: number; after: number; changeText?: string; approx?: boolean; higherIsBetter?: boolean; unit: string; beforeText: string; afterText: string; plain: string; kind: Kind; source: string; date: string; prs: number[] };
type Row = { label: string; value: number; low?: number; high?: number; kind: Kind };
type Chart =
  | { type: "bars"; unit: string; line?: { value: number; label: string }; rows: Row[] }
  | { type: "split"; segments: { label: string; pct: number }[] }
  | { type: "band"; band: number; points: { label: string; pct: number; kind: Kind }[] }
  | { type: "gauge"; max: number; unit: string; limit: number; limitLabel: string; marks: { label: string; value: number; kind: Kind }[] };
type Lesson = { id: string; head: string; plain: string; kind: Kind; source: string; date: string; chart: Chart };
type Cells = { safari: string; chrome: string; edge: string; none: string };
export type Front = {
  title: string;
  byline: string;
  asOf: string;
  why: string;
  kinds: Record<Kind, string>;
  wins: Win[];
  lessons: Lesson[];
  machines: { name: string; cells: Cells }[];
  machineSource: string;
  gates: string[];
  prsWhy: string;
};
export type Live = {
  merged: { mergedAt: string; additions: number; deletions: number }[];
  baseTag: string;
  checks: number;
  ciJobs: string[];
  upMerged: number;
  upOpen: number;
  upTotal: number;
  prLink: (n: number) => string;
};

const KINDS: Kind[] = ["measured", "model", "estimate"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads front.json and throws on any number that lacks its kind, source or date, so nothing reaches the page unsourced. */
export function readFront(file: string): Front {
  const f = JSON.parse(fs.readFileSync(file, "utf8")) as Front;
  const need = (ok: unknown, where: string, what: string) => {
    if (!ok) throw new Error("front.json: " + where + " needs " + what);
  };
  for (const k of KINDS) need(f.kinds?.[k], "kinds", k);
  const sourced = (x: { id: string; kind: Kind; source: string; date: string }) => {
    need(KINDS.includes(x.kind), x.id, "a kind of " + KINDS.join(", "));
    need(x.source, x.id, "a source");
    need(DATE.test(x.date), x.id, "a date (YYYY-MM-DD)");
  };
  for (const w of f.wins) {
    sourced(w);
    for (const k of ["head", "unit", "beforeText", "afterText", "plain"] as const) need(w[k], w.id, k);
    need(Number.isFinite(w.before) && Number.isFinite(w.after), w.id, "numeric before and after");
    need(Array.isArray(w.prs), w.id, "a prs list");
  }
  for (const l of f.lessons) {
    sourced(l);
    need(l.chart, l.id, "a chart");
    const c = l.chart;
    if (c.type === "bars") for (const r of c.rows) need(KINDS.includes(r.kind) && Number.isFinite(r.value), l.id, "a kind and value on every row");
    if (c.type === "band") for (const p of c.points) need(KINDS.includes(p.kind), l.id, "a kind on every point");
    if (c.type === "gauge") for (const m of c.marks) need(KINDS.includes(m.kind), l.id, "a kind on every mark");
  }
  return f;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);
}

function pct(n: number): string {
  return n.toFixed(1) + "%";
}

function kindPill(f: Front, k: Kind): string {
  return '<span class="pill k-' + k + '" title="' + esc(f.kinds[k]) + '">' + k + "</span>";
}

function source(f: Front, x: { kind: Kind; source: string; date: string }, prs: number[], live: Live, label: string): string {
  return "<details><summary>" + label + '</summary><p class="muted">' + esc(f.kinds[x.kind]) + ", " + x.date + '</p><p class="tech">' + esc(x.source) + "</p>" + (prs.length ? '<p class="tech-line">Changes: ' + prs.map(live.prLink).join(", ") + "</p>" : "") + "</details>";
}

function bars(c: Extract<Chart, { type: "bars" }>): string {
  const max = Math.max(...c.rows.map((r) => r.high ?? r.value), c.line?.value ?? 0) || 1;
  const w = (v: number) => Math.max(0.6, (v / max) * 100).toFixed(2) + "%";
  return '<div class="fbars">' + c.rows.map((r) => {
    const range = r.low !== undefined && r.high !== undefined ? fmt(r.low) + "–" + fmt(r.high) : r.high !== undefined && r.high === r.value ? "≤" + fmt(r.value) : fmt(r.value);
    return '<div class="fbar-row"><span class="fbar-label">' + esc(r.label) + '</span><div class="fbar-track">' +
      (r.low !== undefined && r.high !== undefined ? '<div class="fbar-range k-' + r.kind + '" style="left:' + w(r.low) + ";width:calc(" + w(r.high) + " - " + w(r.low) + ')"></div>' : "") +
      '<div class="fbar k-' + r.kind + '" style="width:' + w(r.value) + '"></div>' +
      (c.line ? '<div class="fbar-line" style="left:' + w(c.line.value) + '"></div>' : "") +
      '</div><span class="fbar-val">' + range + "</span></div>";
  }).join("") + '<p class="fbar-unit muted">' + esc(c.unit) + (c.line ? '<span class="fbar-key"><span class="fbar-line-key"></span>' + esc(c.line.label) + " (" + fmt(c.line.value) + ")</span>" : "") + "</p></div>";
}

function split(c: Extract<Chart, { type: "split" }>): string {
  return '<div class="fsplit">' + c.segments.map((s, i) => '<span class="seg s' + i + '" style="flex-basis:' + s.pct + '%" title="' + esc(s.label) + " " + pct(s.pct) + '"></span>').join("") + '</div><ul class="dlegend">' +
    c.segments.map((s, i) => '<li><span class="sw seg s' + i + '"></span>' + esc(s.label) + ' <span class="muted fpct">' + pct(s.pct) + "</span></li>").join("") + "</ul>";
}

function band(c: Extract<Chart, { type: "band" }>): string {
  const lo = -10;
  const hi = 35;
  const x = (v: number) => (((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100).toFixed(2) + "%";
  const ticks = [-5, 0, 5, 10, 20, 30];
  return '<div class="fband"><div class="fband-track"><div class="fband-noise" style="left:' + x(-c.band) + ";width:calc(" + x(c.band) + " - " + x(-c.band) + ')"><span>±' + c.band + '% noise</span></div><div class="fband-zero" style="left:' + x(0) + '"></div>' +
    c.points.map((p, i) => '<div class="fband-pt k-' + p.kind + (i % 2 ? " below" : "") + '" style="left:' + x(p.pct) + '"><span>' + esc(p.label) + " " + (p.pct > 0 ? "+" : "") + fmt(p.pct) + "%</span></div>").join("") +
    '</div><div class="fband-axis">' + ticks.map((t) => '<span style="left:' + x(t) + '">' + (t > 0 ? "+" : "") + t + "%</span>").join("") + "</div></div>";
}

function gauge(c: Extract<Chart, { type: "gauge" }>): string {
  const cx = 160;
  const cy = 150;
  const r = 120;
  const at = (v: number, rr: number) => {
    const a = Math.PI * (1 - Math.min(v, c.max) / c.max);
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)].map((n) => n.toFixed(1));
  };
  const arc = (from: number, to: number, cls: string) => {
    const [x0, y0] = at(from, r);
    const [x1, y1] = at(to, r);
    return '<path class="' + cls + '" d="M' + x0 + " " + y0 + " A" + r + " " + r + " 0 0 1 " + x1 + " " + y1 + '"/>';
  };
  const [lx0, ly0] = at(c.limit, r - 22);
  const [lx1, ly1] = at(c.limit, r + 14);
  const needles = c.marks.map((m, i) => {
    const [x, y] = at(m.value, r - 30);
    return '<line class="needle n' + i + " k-" + m.kind + '" x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '"/>';
  }).join("");
  const label = c.marks.map((m) => m.label + " " + fmt(m.value) + " " + c.unit).join(", ") + ". " + c.limitLabel;
  return '<div class="fgauge"><svg viewBox="0 0 320 175" aria-label="' + esc(label) + '"><title>' + esc(label) + "</title>" + arc(0, c.max, "g-track") + arc(c.limit, c.max, "g-over") +
    '<line class="g-limit" x1="' + lx0 + '" y1="' + ly0 + '" x2="' + lx1 + '" y2="' + ly1 + '"/>' + needles + '<circle class="g-hub" cx="' + cx + '" cy="' + cy + '" r="6"/>' +
    '<text class="g-end" x="' + (cx - r) + '" y="' + (cy + 20) + '" text-anchor="middle">0</text><text class="g-end" x="' + (cx + r) + '" y="' + (cy + 20) + '" text-anchor="middle">' + c.max + " " + esc(c.unit) + "</text></svg>" +
    '<ul class="dlegend">' + c.marks.map((m, i) => '<li><span class="sw needle-key n' + i + '"></span>' + esc(m.label) + ": " + fmt(m.value) + " " + esc(c.unit) + "</li>").join("") + '<li><span class="sw-ceil ceil-measured"></span>' + esc(c.limitLabel) + "</li></ul></div>";
}

function chart(c: Chart): string {
  if (c.type === "bars") return bars(c);
  if (c.type === "split") return split(c);
  if (c.type === "band") return band(c);
  return gauge(c);
}

function perDay(live: Live): string {
  const days = new Map<string, number>();
  for (const p of live.merged) days.set(p.mergedAt.slice(0, 10), (days.get(p.mergedAt.slice(0, 10)) ?? 0) + 1);
  const keys = [...days.keys()].sort();
  const first = new Date(keys[0] + "T00:00:00Z").getTime();
  const last = new Date(keys[keys.length - 1] + "T00:00:00Z").getTime();
  const all: [string, number][] = [];
  for (let t = first; t <= last; t += 86400000) {
    const k = new Date(t).toISOString().slice(0, 10);
    all.push([k, days.get(k) ?? 0]);
  }
  const max = Math.max(...all.map((d) => d[1])) || 1;
  const bw = 56;
  const h = 150;
  const w = all.length * bw;
  const label = "Pull requests merged per day: " + all.map((d) => d[0] + " " + d[1]).join(", ");
  return '<div class="fdays"><svg viewBox="0 0 ' + w + " " + (h + 40) + '" aria-label="' + esc(label) + '"><title>' + esc(label) + "</title>" +
    all.map((d, i) => {
      const bh = (d[1] / max) * h;
      const x = i * bw + 10;
      return '<rect class="day" x="' + x + '" y="' + (h - bh + 16).toFixed(1) + '" width="' + (bw - 20) + '" height="' + bh.toFixed(1) + '"/><text class="v" x="' + (x + (bw - 20) / 2) + '" y="' + (h - bh + 10).toFixed(1) + '" text-anchor="middle">' + d[1] + '</text><text class="d" x="' + (x + (bw - 20) / 2) + '" y="' + (h + 34) + '" text-anchor="middle">' + d[0].slice(5) + "</text>";
    }).join("") + "</svg></div>";
}

/** The Hill climb page: one chart per metric from hillclimb.json, with every point in a table. */
export function renderHillPage(h: Hill, prLink: (n: number) => string): string {
  const live = { prLink };
  const card = ([id, m]: [string, HillMetric]) => {
    const pts = h.points.filter((p) => p.metric === id);
    const series = Object.entries(m.series);
    const body = !pts.length
      ? '<p class="pending">' + esc(m.pending ?? "Not measured yet.") + "</p>"
      : m.state
        ? '<ul class="list">' + pts.map((p) => "<li><b>" + esc(p.at) + "</b> " + esc(m.series[p.series].label) + ": " + esc(p.state as string) + "</li>").join("") + "</ul>"
        : '<div class="chart hwrap">' + renderHillChart(id, m, h.points) + '</div><ul class="dlegend">' + series.map(([, s], i) => '<li><span class="sw h' + i + '"></span>' + esc(s.label) + ' <span class="muted fpct">' + esc(s.machine) + "</span></li>").join("") +
          (m.budget ? '<li><span class="sw-budget"></span>' + esc(m.budget.label) + "</li>" : "") + (m.reference ? '<li><span class="sw-ref"></span>' + esc(m.reference.label) + " " + m.reference.low + "–" + m.reference.high + " " + esc(m.unit) + "</li>" : "") + "</ul>";
    const rows = pts.map((p) => '<tr class="k-' + p.kind + '"><td data-label="Step">' + esc(p.at) + (p.pr ? " " + live.prLink(p.pr) : "") + (p.release ? " " + esc(p.release) : "") + '</td><td data-label="Line">' + esc(m.series[p.series].label) + '</td><td data-label="Value" class="now">' + (p.state !== undefined ? esc(p.state) : fmt(p.value as number) + " " + esc(m.unit) + (p.low !== undefined ? ' <span class="muted">(' + fmt(p.low) + "–" + fmt(p.high as number) + ")</span>" : "")) + '</td><td data-label="Type"><span class="pill k-' + p.kind + '">' + p.kind + '</span></td><td data-label="Build">' + esc(p.build) + '</td><td data-label="Runs">' + (p.n || "none") + '</td><td data-label="Date (UTC)">' + p.date + '</td></tr><tr class="note-row"><td colspan="7">' + esc(p.method) + ". " + esc(p.source) + (p.note ? ". " + esc(p.note) : "") + "</td></tr>").join("");
    return '<div class="card hcard"><div class="fwin-top"><h3>' + esc(m.label) + (m.unit ? ' <span class="muted">(' + esc(m.unit) + ")</span>" : "") + "</h3>" + (pts.length ? "" : '<span class="pill s-waiting">not measured yet</span>') + '</div><p class="plain">' + esc(m.plain) + "</p>" + body +
      (pts.length ? '<details><summary>Every point</summary><div class="table-wrap"><table class="play points"><thead><tr><th>Step</th><th>Line</th><th>Value</th><th>Type</th><th>Build</th><th>Runs</th><th>Date (UTC)</th></tr></thead><tbody>' + rows + "</tbody></table></div></details>" : "") + "</div>";
  };
  return '<h2>Hill climb: CPU, power and smoothness</h2><p class="lead">' + esc(h.plain) + "</p>" +
    '<ul class="dlegend key"><li><span class="mk mk-measured"></span>measured</li><li><span class="mk mk-estimate"></span>estimate</li><li><span class="mk mk-planned"></span>target</li><li><span class="sw-budget"></span>budget</li></ul>' +
    '<div class="grid">' + Object.entries(h.metrics).map(card).join("") + "</div>";
}

/** The front page's HTML: why, biggest wins, what I learned, what I test on, why so many PRs, where I'm going. */
export function renderFront(f: Front, live: Live, goalBars: string): string {
  const sizes = live.merged.map((p) => p.additions + p.deletions).sort((a, b) => a - b);
  const median = sizes.length ? (sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2) : 0;
  const small = sizes.filter((n) => n <= 200).length;
  const stat = (n: string, label: string, note: string) => '<div class="stat"><div class="big">' + esc(n) + '</div><div class="label">' + esc(label) + '</div><div class="note">' + esc(note) + "</div></div>";
  const win = (w: Win) => {
    const max = Math.max(w.before, w.after) || 1;
    const better = w.higherIsBetter ? w.after > w.before : w.after < w.before;
    const ratio = w.higherIsBetter ? w.after / w.before : w.before / w.after;
    const change = ratio >= 2 ? (w.approx ? "about " : "") + fmt(ratio) + "× " + (w.higherIsBetter ? "more" : "fewer") : (w.higherIsBetter ? "+" : "−") + fmt(Math.abs((w.after - w.before) / w.before) * 100) + "%";
    return '<div class="card fwin"><div class="fwin-top"><h3>' + esc(w.head) + "</h3>" + kindPill(f, w.kind) + "</div>" +
      '<div class="fwin-nums"><span class="fwin-before">' + (w.approx ? "~" : "") + fmt(w.before) + '</span><span class="fwin-arrow" aria-hidden="true">→</span><span class="fwin-after' + (better ? "" : " worse") + '">' + (w.approx ? "~" : "") + fmt(w.after) + '</span><span class="fwin-unit">' + esc(w.unit) + "</span></div>" +
      '<p class="fwin-change">' + esc(w.changeText ?? change) + "</p>" +
      '<div class="fwin-bars"><div class="bar-track"><div class="bar before" style="width:' + ((w.before / max) * 100).toFixed(1) + '%"></div></div><div class="bar-track"><div class="bar after k-' + w.kind + '" style="width:' + ((w.after / max) * 100).toFixed(1) + '%"></div></div></div>' +
      '<dl class="fwin-ba"><dt>Before</dt><dd>' + esc(w.beforeText) + "</dd><dt>Now</dt><dd>" + esc(w.afterText) + "</dd></dl>" +
      '<p class="plain">' + esc(w.plain) + "</p>" + source(f, w, w.prs, live, "How I know") + "</div>";
  };
  const lesson = (l: Lesson) => '<div class="card flesson"><div class="fwin-top"><h3>' + esc(l.head) + "</h3>" + kindPill(f, l.kind) + '</div><p class="plain">' + esc(l.plain) + "</p>" + chart(l.chart) + source(f, l, [], live, "Where this comes from") + "</div>";
  const cols: [keyof Cells, string][] = [["safari", "Safari"], ["chrome", "Chrome"], ["edge", "Edge"], ["none", "No graphics card"]];
  return '<div class="hero front"><p class="byline">' + esc(f.byline) + "</p><h1>" + esc(f.title) + '</h1><p class="lead">' + esc(f.why) + "</p>" +
    '<ul class="dlegend key"><li>' + kindPill(f, "measured") + " " + esc(f.kinds.measured) + "</li><li>" + kindPill(f, "model") + " " + esc(f.kinds.model) + "</li><li>" + kindPill(f, "estimate") + " " + esc(f.kinds.estimate) + "</li></ul></div>" +
    "<h2>What I'm chasing</h2>" + goalBars + '<p class="tech-line"><a href="#goals">Every goal, its steps and the PRs moving it →</a></p>' +
    "<h2>Biggest wins</h2><div class=\"story\">" + f.wins.map(win).join("") + "</div>" +
    "<h2>What I learned along the way</h2><div class=\"story\">" + f.lessons.map(lesson).join("") + "</div>" +
    '<h2>What I test on</h2><p class="lead">A change that helps one setup can hurt another, so every release runs on all of these before it goes stable.</p>' +
    '<div class="table-wrap"><table class="play fmatrix"><thead><tr><th>Machine</th>' + cols.map((c) => "<th>" + c[1] + "</th>").join("") + "</tr></thead><tbody>" +
    f.machines.map((m) => '<tr><td class="now">' + esc(m.name) + "</td>" + cols.map((c) => '<td data-label="' + c[1] + '"' + (m.cells[c[0]] ? ' class="on"' : "") + ">" + (m.cells[c[0]] ? esc(m.cells[c[0]]) : '<span class="faint">·</span>') + "</td>").join("") + "</tr>").join("") +
    '</tbody></table></div><p class="tech">' + esc(f.machineSource) + "</p>" +
    '<div class="card"><h3>Before a release goes stable</h3><ol class="fsteps">' + f.gates.map((g) => "<li>" + esc(g) + "</li>").join("") + "</ol>" +
    '<p class="tech-line"><a href="#releases">Every release and its check results →</a></p></div>' +
    '<h2>Why so many PRs</h2><p class="lead">' + esc(f.prsWhy) + "</p>" +
    '<div class="stats">' + stat(String(live.merged.length), "PRs merged", "since " + live.baseTag + ", live from GitHub") + stat(fmt(median), "lines changed, median PR", small + " of " + sizes.length + " change 200 lines or fewer") + stat(String(live.checks), "checks in npm test", "run on every PR, plus " + live.ciJobs.length + " CI jobs") + stat(live.upMerged + " of " + live.upTotal, "accepted upstream", live.upOpen + " waiting for review on Max's game") + "</div>" +
    '<div class="card"><h3>PRs merged per day (UTC)</h3>' + perDay(live) + '<p class="muted">CI jobs on every PR: ' + live.ciJobs.map(esc).join(", ") + ".</p></div>" +
    '<p class="muted fnav">Numbers as of ' + esc(f.asOf) + '; counts are live as of the build time in the footer. The full pages are under <a href="#more">More</a>.</p>';
}
