// Goals, tentpoles, incoming PRs and the release timeline. goals.json names each goal, what 100% means and how its
// progress is computed from data (steps done, a devices.json line against its goal, a hillclimb.json series against a
// target, or live upstream counts); release-gates.json holds each kong-v tag's D3D11 and Metal gate results. build.mts
// passes the live GitHub data in, and this module renders the front page's goal bars, the Goals page and the Releases
// timeline as plain HTML that follows the light and dark themes in style.css.
import fs from "node:fs";
import type { Devices } from "./device-chart.mts";
import type { Hill } from "./hillclimb.mts";

type Step = { label: string; pr?: number; done?: boolean; evidence?: string; hill?: { metric: string; series?: string; atMost?: number; atLeast?: number } };
type Progress = { type: "steps" } | { type: "device"; sku: string; chart: string; line: string } | { type: "hill"; metric: string; series: string; target: number } | { type: "upstream" };
type Goal = { id: string; name: string; issue?: string; tentpole?: boolean; plain: string; full: string; page?: string; progress: Progress; match: string; steps: Step[] };
export type Goals = { about: string[]; waiting: Record<string, string>; goals: Goal[] };
type Verdict = { verdict: "pass" | "fail"; note?: string; source: string };
export type Gates = { about: string; releases: Record<string, { d3d11?: Verdict; metal?: Verdict }> };
export type GhPr = { number: number; title: string; state: string; isDraft?: boolean; mergedAt: string | null; createdAt: string };
export type GhRelease = { tagName: string; isPrerelease: boolean; publishedAt: string; url: string; body: string };
export type GoalCtx = {
  prs: GhPr[];
  devices: Devices;
  hill: Hill;
  upMerged: number;
  upTotal: number;
  now: number;
  shown: (title: string) => boolean;
  plainOf: (n: number) => string | undefined;
  prLink: (n: number) => string;
};
type Scored = { goal: Goal; pct: number; headline: string; steps: { step: Step; done: boolean; why: string }[] };

const RECENT_MS = 24 * 60 * 60 * 1000;
const PR_LIST_MAX = 8;

/** Reads goals.json and throws on a goal without a definition of 100%, a progress rule, or a step that claims done without evidence. */
export function readGoals(file: string): Goals {
  const g = JSON.parse(fs.readFileSync(file, "utf8")) as Goals;
  for (const goal of g.goals) {
    if (!goal.full || !goal.plain || !goal.progress) throw new Error("goals.json: " + goal.id + " needs plain, full and progress");
    new RegExp(goal.match);
    for (const s of goal.steps) if (s.done === true && !s.evidence) throw new Error("goals.json: " + goal.id + " step \"" + s.label + "\" is done without evidence");
  }
  return g;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function gb(mb: number): string {
  return (mb / 1000).toFixed(1) + " GB";
}

function clean(t: string): string {
  return t.replace(/\s*\((?:RAY|KONG)-\d+[^)]*\)\s*$/, "");
}

function measured(h: Hill, metric: string, series?: string) {
  return h.points.filter((p) => p.metric === metric && (!series || p.series === series) && p.kind === "measured");
}

/** Scores every goal from data: the share of steps done, or a measured value between its start and its target. */
export function scoreGoals(g: Goals, ctx: GoalCtx): Scored[] {
  const byNum = new Map(ctx.prs.map((p) => [p.number, p]));
  const stepDone = (s: Step) => {
    if (s.pr !== undefined) {
      const p = byNum.get(s.pr);
      return { done: p?.state === "MERGED", why: "#" + s.pr + (p ? (p.state === "MERGED" ? " merged" : p.state === "OPEN" ? (p.isDraft ? " draft" : " open") : " closed") : "") };
    }
    if (s.hill) {
      const pts = measured(ctx.hill, s.hill.metric, s.hill.series);
      const last = pts[pts.length - 1];
      const ok = !!last && (s.hill.atMost === undefined || (last.value as number) <= s.hill.atMost) && (s.hill.atLeast === undefined || (last.value as number) >= s.hill.atLeast);
      return { done: ok, why: last ? "newest " + last.value + " at " + last.at : "not measured yet" };
    }
    return { done: s.done === true, why: s.evidence ?? "" };
  };
  return g.goals.map((goal) => {
    const steps = goal.steps.map((step) => ({ step, ...stepDone(step) }));
    const p = goal.progress;
    if (p.type === "steps") {
      const done = steps.filter((s) => s.done).length;
      return { goal, steps, pct: steps.length ? (done / steps.length) * 100 : 0, headline: done + " of " + steps.length + " steps done" };
    }
    if (p.type === "upstream") return { goal, steps, pct: ctx.upTotal ? (ctx.upMerged / ctx.upTotal) * 100 : 0, headline: ctx.upMerged + " of " + ctx.upTotal + " PRs accepted upstream" };
    if (p.type === "hill") {
      const pts = measured(ctx.hill, p.metric, p.series);
      if (!pts.length) return { goal, steps, pct: 0, headline: "not measured yet" };
      const a = pts[0].value as number;
      const b = pts[pts.length - 1].value as number;
      const unit = ctx.hill.metrics[p.metric].unit;
      return { goal, steps, pct: Math.max(0, Math.min(100, ((b - a) / (p.target - a)) * 100)), headline: a + " → " + b + " " + unit + ", target " + p.target + " " + unit };
    }
    const line = ctx.devices.skus.find((s) => s.id === p.sku)?.charts.find((c) => c.id === p.chart)?.lines.find((l) => l.id === p.line);
    if (!line) throw new Error("goals.json: " + goal.id + " names a devices.json line that doesn't exist");
    const order = (slot: string) => ctx.devices.slots.findIndex((s) => s.id === slot);
    const pts = line.points.filter((x) => x.kind === "measured").sort((x, y) => order(x.slot) - order(y.slot));
    const target = line.points.find((x) => x.slot === "goal");
    if (!pts.length || !target) throw new Error("goals.json: " + goal.id + " needs measured points and a goal point");
    const a = pts[0].mb;
    const b = pts[pts.length - 1].mb;
    return { goal, steps, pct: Math.max(0, Math.min(100, ((a - b) / (a - target.mb)) * 100)), headline: gb(a) + " → " + gb(b) + ", target " + gb(target.mb) };
  });
}

function bar(pct: number): string {
  return '<div class="gbar"><div style="width:' + Math.max(1, pct).toFixed(1) + '%"></div></div>';
}

/** The front page's goal list: one bar per goal, tentpoles first. */
export function renderGoalBars(scored: Scored[]): string {
  const sorted = [...scored.filter((s) => s.goal.tentpole), ...scored.filter((s) => !s.goal.tentpole)];
  return '<div class="goals">' + sorted.map((s) => '<a class="goal" href="#goals"><div class="goal-head"><span class="goal-name">' + esc(s.goal.name) + "</span>" + (s.goal.tentpole ? '<span class="pill tentpole">tentpole</span>' : "") + '<span class="goal-pct">' + Math.round(s.pct) + "%</span></div>" + bar(s.pct) + '<div class="goal-note muted">' + esc(s.headline) + "</div></a>").join("") + "</div>";
}

/** The Goals page: each goal's bar, what 100% means, its steps, and the open and recent PRs that advance it. */
export function renderGoalsPage(g: Goals, scored: Scored[], ctx: GoalCtx): string {
  const recent = ctx.prs.filter((p) => ctx.shown(p.title) && (p.state === "OPEN" || (p.mergedAt && ctx.now - Date.parse(p.mergedAt) <= RECENT_MS)));
  const owner = (p: GhPr) => g.goals.find((goal) => goal.steps.some((s) => s.pr === p.number)) ?? g.goals.find((goal) => new RegExp(goal.match, "i").test(p.title));
  const status = (p: GhPr) => p.state === "MERGED" ? '<span class="pill s-done">merged ' + (p.mergedAt as string).slice(5, 10) + "</span>" : p.isDraft ? '<span class="pill s-todo">draft</span>' : g.waiting[String(p.number)] ? '<span class="pill s-waiting">' + esc(g.waiting[String(p.number)]) + "</span>" : '<span class="pill next">in review</span>';
  const prRow = (p: GhPr) => "<li>" + status(p) + ' <span class="plain">' + esc(ctx.plainOf(p.number) ?? clean(p.title)) + "</span> " + ctx.prLink(p.number) + "</li>";
  const sorted = [...scored.filter((s) => s.goal.tentpole), ...scored.filter((s) => !s.goal.tentpole)];
  const pageName: Record<string, string> = { hill: "Hill climb", devices: "Memory by device" };
  const cards = sorted.map((s) => {
    const mine = recent.filter((p) => owner(p) === s.goal).sort((a, b) => (a.state === "OPEN" ? 0 : 1) - (b.state === "OPEN" ? 0 : 1) || b.number - a.number);
    return '<div class="card gcard"><div class="fwin-top"><h3>' + esc(s.goal.name) + (s.goal.issue ? ' <span class="muted tech-line">' + esc(s.goal.issue) + "</span>" : "") + "</h3>" + (s.goal.tentpole ? '<span class="pill tentpole">tentpole</span>' : "") + "</div>" +
      '<p class="plain">' + esc(s.goal.plain) + '</p><div class="goal-head"><span class="goal-pct big">' + Math.round(s.pct) + '%</span><span class="muted">' + esc(s.headline) + "</span></div>" + bar(s.pct) +
      '<p class="muted gfull"><b>100% means:</b> ' + esc(s.goal.full) + "</p>" +
      (s.steps.length ? '<ul class="gsteps">' + s.steps.map((x) => '<li class="' + (x.done ? "done" : "todo") + '"><span class="tick" aria-hidden="true">' + (x.done ? "✓" : "○") + "</span>" + esc(x.step.label) + (x.step.pr ? " " + ctx.prLink(x.step.pr) : "") + (x.why && !x.step.pr ? ' <span class="muted">' + esc(x.why) + "</span>" : "") + "</li>").join("") + "</ul>" : "") +
      (mine.length ? '<details open><summary>Open, and merged in the last 24 hours (' + mine.length + ')</summary><ul class="list">' + mine.slice(0, PR_LIST_MAX).map(prRow).join("") + "</ul>" + (mine.length > PR_LIST_MAX ? '<p class="muted">and ' + (mine.length - PR_LIST_MAX) + ' more on the <a href="#overview">Overview</a> page.</p>' : "") + "</details>" : "") +
      (s.goal.page ? '<p class="tech-line"><a href="#' + s.goal.page + '">' + esc(pageName[s.goal.page] ?? s.goal.page) + " →</a></p>" : "") + "</div>";
  }).join("");
  const other = recent.filter((p) => !owner(p));
  return '<h2>Goals</h2><p class="lead">What I\'m chasing, how far along each one is, and the PRs moving it. Every bar is computed from data: steps merged on GitHub, or a measured number against its target.</p>' +
    '<div class="grid">' + cards + "</div>" +
    (other.length ? '<div class="card"><details><summary>Other PRs open or merged in the last 24 hours (' + other.length + ')</summary><ul class="list">' + other.sort((a, b) => b.number - a.number).map(prRow).join("") + "</ul></details></div>" : "");
}

/** The Releases page: every kong-v tag from the shared starting point on, its channel, gate results and fixes by goal. */
export function renderTimeline(releases: GhRelease[], g: Goals, gates: Gates, ctx: GoalCtx & { baseTag: string; baseDate: string; nextTag?: string; stableTag?: string }): string {
  const safari = ctx.devices.skus.find((s) => s.id === "mac16")?.charts.find((c) => c.id === "peak")?.lines.find((l) => l.id === "safari-page")?.points ?? [];
  const safariFor = (tag: string) => safari.find((p) => p.kind === "measured" && p.build.startsWith(tag + " "));
  const cell = (name: string, v?: Verdict) => '<span class="gate ' + (v ? v.verdict : "none") + '" title="' + esc(v ? v.source : "no record on the dashboard") + '">' + esc(name) + ": " + (v ? v.verdict + (v.note ? ", " + esc(v.note) : "") : "no record") + "</span>";
  const safariCell = (tag: string) => {
    const p = safariFor(tag);
    if (!p) return '<span class="gate none" title="no Safari match on record for this tag">Safari 16 GB: no record</span>';
    return '<span class="gate ' + (p.killed ? "fail" : "pass") + '" title="' + esc(p.build + ", " + p.date + ". " + (p.note ?? "")) + '">Safari 16 GB: ' + (p.killed ? "reached the limit" : "finished, " + gb(p.mb)) + "</span>";
  };
  const byNum = new Map(ctx.prs.map((p) => [p.number, p]));
  const goalOf = (p: GhPr) => g.goals.find((goal) => goal.steps.some((s) => s.pr === p.number)) ?? g.goals.find((goal) => new RegExp(goal.match, "i").test(p.title));
  const sorted = [...releases].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const rail = '<ol class="rail"><li class="base"><span class="dot"></span><b>' + esc(ctx.baseTag) + '</b><span class="muted">shared start</span></li>' + sorted.map((r) => '<li class="' + (r.tagName === ctx.stableTag ? "stable" : r.tagName === ctx.nextTag ? "next" : "") + '"><span class="dot"></span><b>' + esc(r.tagName.replace(/^kong-/, "")) + '</b><span class="muted">' + (r.tagName === ctx.stableTag ? "stable" : r.tagName === ctx.nextTag ? "next" : r.publishedAt.slice(5, 10)) + "</span></li>").join("") + "</ol>";
  const card = (r: GhRelease) => {
    const prs = [...r.body.matchAll(/^- #(\d+)/gm)].map((m) => byNum.get(Number(m[1]))).filter((p): p is GhPr => !!p && ctx.shown(p.title));
    const groups = g.goals.map((goal) => ({ name: goal.name, list: prs.filter((p) => goalOf(p) === goal) })).filter((x) => x.list.length);
    const other = prs.filter((p) => !goalOf(p));
    const channel = r.tagName === ctx.stableTag ? '<span class="pill stable">stable</span>' : r.tagName === ctx.nextTag ? '<span class="pill next">next</span>' : "";
    const g2 = gates.releases[r.tagName] ?? {};
    const li = (p: GhPr) => '<li><span class="plain">' + esc(ctx.plainOf(p.number) ?? clean(p.title)) + "</span> " + ctx.prLink(p.number) + "</li>";
    return '<div class="card rcard"><div class="fwin-top"><h3><a href="' + esc(r.url) + '">' + esc(r.tagName) + "</a> " + channel + '</h3><span class="muted">' + r.publishedAt.slice(0, 10) + "</span></div>" +
      '<div class="gates">' + cell("D3D11", g2.d3d11) + cell("Metal", g2.metal) + safariCell(r.tagName) + "</div>" +
      '<p class="muted">' + prs.length + (prs.length === 1 ? " change" : " changes") + (groups.length ? ": " + groups.map((x) => x.list.length + " for " + x.name).join(", ") + (other.length ? ", " + other.length + " other" : "") : "") + ".</p>" +
      groups.map((x) => "<details><summary>" + esc(x.name) + " (" + x.list.length + ')</summary><ul class="list">' + x.list.map(li).join("") + "</ul></details>").join("") +
      (other.length ? "<details><summary>Other changes (" + other.length + ')</summary><ul class="list">' + other.map(li).join("") + "</ul></details>" : "") + "</div>";
  };
  const base = '<div class="card rcard"><div class="fwin-top"><h3>' + esc(ctx.baseTag) + '</h3><span class="muted">' + esc(ctx.baseDate) + '</span></div><div class="gates">' + safariCell("kong-" + ctx.baseTag) + '</div><p class="muted">The shared starting point of both projects: the first public release.</p></div>';
  return '<h2>Releases</h2><p class="lead">Every release from the shared starting point on. A release goes to next first, and to stable after it passes the checks on Windows (D3D11) and the Mac (Metal), and a full Safari match. Hover a check for its source.</p>' +
    rail + [...sorted].reverse().map(card).join("") + base;
}
