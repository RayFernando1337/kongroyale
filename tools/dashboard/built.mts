// "How it's built": the stack from several viewpoints (the stack, networking, determinism, runtime), the TLA+ models and
// what guards every PR. built.json holds the narrative; the formal-model diagrams and the checks table are generated
// from the repo's own files every build (tools/formal/*.tla, *.cfg and *.covers.json, docs/statecharts/*.md,
// tools/run-tests.mjs --list, .github/workflows/ci.yml), so they can't drift from the code. Mermaid sources are rendered
// to inline SVG by diagrams.mts, once for the light theme and once for the dark one, and the CSS shows the right one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ALWAYS_FORBIDDEN } from "./scan.mts";

type Diagram = { caption: string; source: string };
type Section = { id: string; head: string; plain: string[]; diagram: Diagram; diagram2?: Diagram; table?: { title: string; columns: string[]; rows: string[][]; source: string }; files: string[]; checks: ["test" | "ci", string][]; source: string };
type ModelCfg = { id: string; title: string; doc?: { file: string; block: number }; doc2?: { file: string; block: number }; phases?: boolean; actions?: boolean };
type Guards = { tests: Record<string, { label?: string; catches: string; budget?: string }>; ci: Record<string, { label: string; catches: string; budget?: string }>; coming: { name: string; plain: string; pr?: number }[] };
export type Built = { title: string; lead: string; sources: string; sections: Section[]; formal: { head: string; plain: string; models: ModelCfg[] }; guards: { head: string; plain: string; comingPlain: string } };
type Model = { cfg: ModelCfg; blurb: string; rules: { name: string; kind: "invariant" | "property"; text: string }[]; regions: number; mutants: number; sources: Diagram[]; table?: { name: string; text: string }[] };
type Check = { kind: "test" | "ci"; id: string; label: string; speed: string; catches: string; budget?: string };

const WORDS: [RegExp, string][] = [
  [/\(title, room, results lobby\)/g, "(title, waiting area, results screen)"],
  [/\bthe lobby is back in its room\b/g, "the match is closed and its players are back in the waiting area"],
  [/\bWaiting room\b/g, "Waiting area"],
  [/\bwaiting room\b/g, "waiting area"],
  [/\bMaking room\b/g, "Freeing space"],
  [/\(rate limit, full\)/g, "(too busy, full)"],
  [/\ba lobby match\b/gi, "an online match"],
  [/\blobby matches\b/gi, "online matches"],
  [/\blobby match\b/gi, "online match"],
  [/\broom\b/gi, "waiting area"],
  [/\blobby\b/gi, "online"],
];

/** Rewords the few phrases the public page leaves out, then refuses any text that still holds a word the publish scan would reject. */
function publicText(s: string, hide: RegExp, where: string): string {
  const out = WORDS.reduce((t, [re, to]) => t.replace(re, to), s);
  const bad = out.match(new RegExp(ALWAYS_FORBIDDEN + "|" + hide.source, "i"));
  if (bad) throw new Error("how it's built: " + where + " holds \"" + bad[0] + "\", which the public page doesn't show; add a rewording to WORDS in built.mts");
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mermaidBlocks(md: string): { src: string; heading: string }[] {
  const out: { src: string; heading: string }[] = [];
  let heading = "";
  let cur: string[] | undefined;
  for (const line of md.split("\n")) {
    if (cur) {
      if (line.startsWith("```")) {
        out.push({ src: cur.join("\n"), heading });
        cur = undefined;
      } else cur.push(line);
    } else if (line.startsWith("```mermaid")) cur = [];
    else if (/^## /.test(line)) heading = line.slice(3).trim();
  }
  return out;
}

function skillBlurb(root: string, skill: string): string {
  const m = /^description: (.+)$/m.exec(fs.readFileSync(path.join(root, skill), "utf8"));
  if (!m) throw new Error("how it's built: " + skill + " has no description");
  const text = m[1].split(/ Use before /)[0].replace(/^Model-check Kong Royale's /, "").replace(/ with TLA\+ - /, ": ").replace(/ - and draw it as a statechart \([^)]*\)/, "").replace(/\.$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function readModel(root: string, cfg: ModelCfg, hide: RegExp): Model {
  const dir = path.join(root, "tools", "formal");
  const tla = fs.readFileSync(path.join(dir, cfg.id + ".tla"), "utf8");
  const config = fs.readFileSync(path.join(dir, cfg.id + ".cfg"), "utf8");
  const covers = JSON.parse(fs.readFileSync(path.join(dir, cfg.id + ".covers.json"), "utf8")) as { skill: string; regions: string[] };
  const mutants = JSON.parse(fs.readFileSync(path.join(dir, cfg.id + ".mutants.json"), "utf8")) as unknown[];
  const rules: Model["rules"] = [];
  let kind: "invariant" | "property" | undefined;
  for (const line of config.split("\n")) {
    const head = /^(INVARIANTS?|PROPERT(?:Y|IES))\b/.exec(line);
    if (head) kind = head[1].startsWith("INV") ? "invariant" : "property";
    else if (/^[A-Z]+\b/.test(line)) kind = undefined;
    else if (kind && /^\s+\w+\s*$/.test(line)) {
      const name = line.trim();
      const lines = tla.split("\n");
      const at = lines.findIndex((l) => l.startsWith(name + " =="));
      const above: string[] = [];
      for (let i = at - 1; i >= 0 && /^\\\*/.test(lines[i]); i--) above.unshift(lines[i].replace(/^\\\*\s?/, ""));
      const inline = at >= 0 ? /\\\*\s*(.+)$/.exec(lines[at])?.[1] : undefined;
      const text = publicText(above.join(" ") || inline || "", hide, cfg.id + " " + name);
      let end = at + 1;
      while (at >= 0 && end < lines.length && lines[end].trim() !== "") end++;
      const eventually = at >= 0 && /<>|~>/.test(lines.slice(at, end).join(" "));
      rules.push({ name, kind: kind === "property" && eventually ? "property" : "invariant", text: text.charAt(0).toUpperCase() + text.slice(1) });
    }
  }
  const sources: Diagram[] = [];
  for (const d of [cfg.doc, cfg.doc2]) {
    if (!d) continue;
    const block = mermaidBlocks(fs.readFileSync(path.join(root, d.file), "utf8"))[d.block];
    if (!block) throw new Error("how it's built: " + d.file + " has no mermaid block " + d.block);
    const title = /^title: "(.+)"$/m.exec(block.src)?.[1];
    sources.push({ caption: publicText(title ?? block.heading, hide, d.file), source: publicText(block.src, hide, d.file) });
  }
  let table: Model["table"];
  if (cfg.phases) {
    const edges = [...(/Edges == \{(.*)\}/.exec(tla)?.[1] ?? "").matchAll(/<<"(\w+)", "(\w+)">>/g)].map((m) => m.slice(1, 3));
    if (!edges.length) throw new Error("how it's built: MatchPhases.tla has no Edges");
    sources.push({ caption: "The legal phase changes, read from Edges in MatchPhases.tla", source: "stateDiagram-v2\n  direction LR\n  [*] --> " + edges[0][0] + "\n" + edges.map(([a, b]) => "  " + a + " --> " + b).join("\n") });
  }
  if (cfg.actions) {
    const head = /\(\*([\s\S]*?)\*\)/.exec(tla)?.[1] ?? "";
    table = [];
    for (const line of head.split("\n")) {
      const step = /^ {5}([A-Z][A-Za-z]+) {2,}(.*)$/.exec(line);
      if (step) table.push({ name: step[1], text: step[2] });
      else if (table.length && /^ {10,}\S/.test(line)) table[table.length - 1].text += " " + line.trim();
    }
    if (!table.length) throw new Error("how it's built: VehicleSeats.tla has no action table");
    table = table.map((r) => ({ name: r.name, text: publicText(r.text, hide, "VehicleSeats " + r.name) }));
  }
  return { cfg, blurb: publicText(skillBlurb(root, covers.skill), hide, covers.skill), rules, regions: covers.regions.length, mutants: mutants.length, sources, table };
}

function readChecks(root: string, guards: Guards, hide: RegExp): { checks: Check[]; unmapped: string[] } {
  const unmapped: string[] = [];
  const tests = execFileSync("node", ["tools/run-tests.mjs", "--list"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.trim()).map((l) => /^(\w+)\s+(slow\s+)?(.+)$/.exec(l.trim()) as RegExpExecArray);
  const checks: Check[] = tests.map(([, id, slow, name]) => {
    const g = guards.tests[id];
    if (!g) unmapped.push(id);
    return { kind: "test", id, label: publicText(g?.label ?? name, hide, "check " + id), speed: slow ? "slow" : "fast", catches: g?.catches ? publicText(g.catches, hide, "check " + id) : "description to come", budget: g?.budget };
  });
  const ci = [...fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8").matchAll(/^  ([\w-]+):\n    name: (.+)$/gm)];
  for (const [, id, name] of ci) {
    const g = guards.ci[id];
    if (!g) unmapped.push("ci:" + id);
    checks.push({ kind: "ci", id, label: publicText(g?.label ?? name, hide, "job " + id), speed: "CI", catches: g?.catches ? publicText(g.catches, hide, "job " + id) : "description to come", budget: g?.budget });
  }
  for (const id of Object.keys(guards.tests)) if (!tests.some((t) => t[1] === id)) unmapped.push(id + " (in guards.json, not in run-tests.mjs)");
  return { checks, unmapped };
}

function clean(svg: string, label: string): { svg: string; width: number } {
  const width = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/.exec(svg)?.[1] ?? 800);
  const out = svg
    .replace(/ (?:role|aria-roledescription)="[^"]*"/g, "")
    .replace(/(<svg\b[^>]*?) style="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?) width="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?) height="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)>/, "$1 aria-label=\"" + esc(label) + "\"><title>" + esc(label) + "</title>");
  return { svg: out, width: Math.round(width) };
}

/** Renders every diagram, checks the files each section names still exist, and returns the page's HTML. */
export function renderBuilt(root: string, b: Built, guards: Guards, hide: RegExp, prs: { number: number; state: string }[], prLink: (n: number) => string, here: string): string {
  const models = b.formal.models.map((m) => readModel(root, m, hide));
  const sources: Record<string, string> = {};
  b.sections.forEach((s) => {
    sources[s.id] = s.diagram.source;
    if (s.diagram2) sources[s.id + "-2"] = s.diagram2.source;
    for (const f of s.files) if (!fs.existsSync(path.join(root, f))) throw new Error("how it's built: section " + s.id + " names " + f + ", which no longer exists; update built.json");
  });
  models.forEach((m) => m.sources.forEach((d, i) => (sources[m.cfg.id + "-" + i] = d.source)));
  const rendered = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", path.join(here, "diagrams.mts")], { input: JSON.stringify(sources), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] })) as Record<string, { light: string; dark: string }>;
  const dia = (key: string, d: Diagram) => {
    const light = clean(rendered[key].light, d.caption);
    const dark = clean(rendered[key].dark, d.caption);
    return '<figure class="dia" style="--dw:' + light.width + 'px"><div class="dia-scroll"><div class="dia-light">' + light.svg + '</div><div class="dia-dark">' + dark.svg + "</div></div><figcaption>" + esc(d.caption) + "</figcaption></figure>";
  };
  const { checks, unmapped } = readChecks(root, guards, hide);
  if (unmapped.length) console.warn("how it's built: guards.json needs an entry for: " + unmapped.join(", "));
  for (const c of checks) if (c.budget && !fs.existsSync(path.join(root, c.budget))) throw new Error("how it's built: " + c.id + " names the budget file " + c.budget + ", which doesn't exist");
  const checkLine = (kind: "test" | "ci", id: string) => {
    const c = checks.find((x) => x.kind === kind && x.id === id);
    if (!c) throw new Error("how it's built: a section names the " + kind + " check " + id + ", which doesn't exist");
    return "<li><b>" + esc(c.label) + '</b> <span class="muted">' + esc(c.catches) + "</span></li>";
  };
  const hotFiles = (function count(dir: string): number {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => (e.name === "node_modules" || e.name.startsWith(".") ? n : n + (e.isDirectory() ? count(path.join(dir, e.name)) : /\.hot\.ts$/.test(e.name) ? 1 : 0)), 0);
  })(root);
  const section = (s: Section) => '<div class="card bsec" id="how-' + s.id + '"><h3>' + esc(s.head) + "</h3>" + s.plain.map((p) => '<p class="plain">' + esc(p.replace("{hot}", String(hotFiles))) + "</p>").join("") +
    dia(s.id, s.diagram) + (s.diagram2 ? dia(s.id + "-2", s.diagram2) : "") +
    (s.table ? '<div class="table-wrap"><table class="play"><caption class="muted">' + esc(s.table.title) + "</caption><thead><tr>" + s.table.columns.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" + s.table.rows.map((r) => "<tr>" + r.map((c, i) => '<td data-label="' + esc(s.table!.columns[i]) + '"' + (i === 1 || i === 2 ? ' class="now"' : "") + ">" + esc(c) + "</td>").join("") + "</tr>").join("") + '</tbody></table></div><p class="tech">' + esc(s.table.source) + "</p>" : "") +
    '<h4>What checks it</h4><ul class="list">' + s.checks.map(([k, id]) => checkLine(k, id)).join("") + '</ul><p class="tech-line">Files: ' + s.files.map((f) => "<code>" + esc(f) + "</code>").join(" ") + '</p><p class="tech-line">Source: ' + esc(s.source) + "</p></div>";
  const totalRules = models.reduce((n, m) => n + m.rules.length, 0);
  const totalMutants = models.reduce((n, m) => n + m.mutants, 0);
  const model = (m: Model) => '<div class="card bsec"><h3>' + esc(m.cfg.title) + '</h3><p class="plain">' + esc(m.blurb) + ".</p>" + m.sources.map((d, i) => dia(m.cfg.id + "-" + i, d)).join("") +
    (m.cfg.phases || m.cfg.actions ? '<p class="muted">' + (m.cfg.phases ? "A practice match loops back to the warm-up; an online match ends after the results." : "This model has no checked-in statechart, so the table lists the steps the model allows, read from VehicleSeats.tla.") + "</p>" : "") +
    (m.table ? '<div class="table-wrap"><table class="play"><thead><tr><th>Step</th><th>What it does in the game</th></tr></thead><tbody>' + m.table.map((r) => '<tr><td data-label="Step" class="now">' + esc(r.name) + '</td><td data-label="What it does in the game">' + esc(r.text) + "</td></tr>").join("") + "</tbody></table></div>" : "") +
    '<h4>Rules it proves</h4><ul class="list">' + m.rules.map((r) => "<li><code>" + esc(r.name) + '</code> <span class="pill ' + (r.kind === "invariant" ? "s-done" : "next") + '">' + (r.kind === "invariant" ? "always" : "eventually") + '</span> <span class="muted">' + esc(r.text) + "</span></li>").join("") + "</ul>" +
    '<p class="tech-line"><code>tools/formal/' + esc(m.cfg.id) + ".tla</code> covers " + m.regions + " code regions and is tried against " + m.mutants + " deliberate breakages. The <code>formal</code> step of npm test fails if any region changes after the model last passed.</p></div>";
  const row = (c: Check) => "<tr><td data-label=\"Check\"><b>" + esc(c.label) + '</b></td><td data-label="Catches">' + esc(c.catches) + '</td><td data-label="Runs"><span class="pill ' + (c.kind === "ci" ? "next" : c.speed === "slow" ? "s-todo" : "s-done") + '">' + c.speed + '</span></td><td data-label="Budget">' + (c.budget ? "<code>" + esc(c.budget) + "</code>" : '<span class="faint">·</span>') + "</td></tr>";
  const stateOf = (n?: number) => { const p = prs.find((x) => x.number === n); return !n ? "planned" : !p ? "planned" : p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "in review" : "closed"; };
  const coming = guards.coming.map((c) => "<li><span class=\"pill " + (stateOf(c.pr) === "in review" ? "next" : stateOf(c.pr) === "merged" ? "s-done" : "s-todo") + '">' + stateOf(c.pr) + "</span> <b>" + esc(c.name) + '</b> <span class="muted">' + esc(c.plain) + "</span>" + (c.pr ? " " + prLink(c.pr) : "") + "</li>").join("");
  const html = '<h2>' + esc(b.title) + '</h2><p class="lead">' + esc(b.lead) + '</p><p class="tech-line">Built from: ' + esc(b.sources) + '. Jump to: ' + b.sections.map((s) => '<a href="#how-' + s.id + '">' + esc(s.head) + "</a>").join(" · ") + ' · <a href="#how-formal">Formal models</a> · <a href="#how-guards">What guards every PR</a></p>' +
    b.sections.map(section).join("") +
    '<h2 id="how-formal">' + esc(b.formal.head) + '</h2><p class="lead">' + esc(b.formal.plain) + "</p>" +
    '<div class="stats">' + '<div class="stat"><div class="big">' + models.length + '</div><div class="label">models</div><div class="note">in tools/formal</div></div><div class="stat"><div class="big">' + totalRules + '</div><div class="label">rules proved</div><div class="note">always-true or eventually-true</div></div><div class="stat"><div class="big">' + totalMutants + '</div><div class="label">deliberate breakages caught</div><div class="note">each model must fail on every one</div></div></div>' +
    models.map(model).join("") +
    '<h2 id="how-guards">' + esc(b.guards.head) + '</h2><p class="lead">' + esc(b.guards.plain) + "</p>" +
    '<div class="table-wrap"><table class="play guards"><thead><tr><th>Check</th><th>What it catches</th><th>Runs</th><th>Budget file</th></tr></thead><tbody>' + checks.map(row).join("") + "</tbody></table></div>" +
    '<div class="card"><h3>Coming</h3><p class="plain">' + esc(b.guards.comingPlain) + '</p><ul class="list">' + coming + "</ul></div>";
  return html;
}
