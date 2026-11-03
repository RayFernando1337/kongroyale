// Compares repeated benchmark runs (kong-perf-result files, schema.ts) at the run level and sets an exit status.
//   npx tsx tools/performance/compare.mts --base b1.json b2.json b3.json --cand c1.json c2.json c3.json
//   npx tsx tools/performance/compare.mts --base b1.json b2.json b3.json          (noise floor of one side only)
// Options: --stats p50,p95,p99 (which per-run statistic to compare), --threshold 5 (% change that counts),
// --metrics hostTickMs,simulationMs (default: every metric), --out comparison.json.
// Each run contributes ONE value per metric and statistic; frames/ticks inside a run are correlated and never pooled.
// A change is "worse"/"better" only when every candidate run falls outside the baseline runs' range AND the medians
// differ by at least the threshold. Anything else is reported as no clear change or inconclusive.
// Exit status: 0 no regression; 1 a regression, a failed candidate gate, or a candidate metric that is invalid or no
// longer measured; 2 inputs that cannot be compared (including a --metrics name no case has).
import fs from "node:fs";
import path from "node:path";
import { comparabilityKey, parseResult, type Metric, type RunResult, type Summary } from "./schema.ts";

const MIN_RUNS = 3;
const argv = process.argv.slice(2);
const list = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return []; const out: string[] = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]); return out; };
const opt = (flag: string, fallback: string) => list(flag)[0] ?? fallback;
const baseFiles = list("--base"), candFiles = list("--cand");
const statNames = opt("--stats", "p50,p95,p99").split(",") as Array<keyof Summary>;
const threshold = Number(opt("--threshold", "5")), onlyMetrics = list("--metrics").flatMap((m) => m.split(",")), out = list("--out")[0];
for (const s of statNames) if (!["n", "mean", "p50", "p95", "p99", "max"].includes(s)) fail(`unknown statistic ${s}`);
if (!baseFiles.length) fail("pass at least one --base result file");
if (!(threshold >= 0)) fail("--threshold must be a non-negative percentage");

function fail(msg: string): never { console.error("compare: " + msg); process.exit(2); }
const load = (f: string) => { try { return parseResult(JSON.parse(fs.readFileSync(f, "utf8")), f); } catch (e) { fail((e as Error).message); } };
const base = baseFiles.map(load), cand = candFiles.map(load), runs = [...base, ...cand], files = [...baseFiles, ...candFiles];

const key0 = comparabilityKey(runs[0]);
runs.forEach((r, i) => { if (comparabilityKey(r) !== key0) fail(`${files[i]} ran a different workload or machine than ${files[0]}:\n  ${comparabilityKey(r)}\n  ${key0}`); });
const warnings: string[] = [];
const dirty = files.filter((_, i) => runs[i].source.dirty);
if (dirty.length) warnings.push(`${dirty.length} run(s) measured a checkout with uncommitted changes, so their commit does not identify the code: ${dirty.join(", ")}`);
if (base.length >= 2 && cand.length >= 2) {
  const order = runs.map((r, i) => ({ t: Date.parse(r.startedAt), side: i < base.length ? "b" : "c" })).sort((a, b) => a.t - b.t).map((x) => x.side).join("");
  if (/^b+c+$|^c+b+$/.test(order)) warnings.push("baseline and candidate runs were not interleaved; machine drift can look like a change");
}

const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y), n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };
const valueOf = (m: Metric, stat: keyof Summary) => m.status !== "ok" ? null : "value" in m ? m.value : m.summary[stat];
interface Row { scenario: string; metric: string; stat: string; unit: string; verdict: string; base?: Side; cand?: Side; deltaPct?: number; reason?: string }
interface Side { n: number; median: number; min: number; max: number; spreadPct: number; values: number[] }
const side = (values: number[]): Side => { const md = median(values), min = Math.min(...values), max = Math.max(...values); return { n: values.length, median: md, min, max, spreadPct: md ? ((max - min) / Math.abs(md)) * 100 : 0, values }; };

const rows: Row[] = [], failedGates: string[] = [], lostMetrics: string[] = [];
const known = new Set(runs.flatMap((r) => r.cases.flatMap((c) => Object.keys(c.metrics))));
for (const m of onlyMetrics) if (!known.has(m)) fail(`--metrics ${m} is not in any case; known: ${[...known].join(", ")}`);
const caseOf = (r: RunResult, id: string) => r.cases.find((c) => c.scenario.id === id);
for (const id of [...new Set(runs.flatMap((r) => r.cases.map((c) => c.scenario.id)))]) {
  const cases = runs.map((r, i) => { const c = caseOf(r, id); if (!c) fail(`${files[i]} has no scenario ${id}`); return c; });
  const s0 = JSON.stringify(cases[0].scenario);
  cases.forEach((c, i) => { if (JSON.stringify(c.scenario) !== s0) fail(`${files[i]}: scenario ${id} is ${JSON.stringify(c.scenario)}, expected ${s0}`); });
  cases.forEach((c, i) => { for (const g of c.gates) if (!g.pass) { const msg = `${i < base.length ? "baseline" : "candidate"} ${files[i]}: ${id} ${g.id}: ${g.detail}`; if (i < base.length) warnings.push(msg); else failedGates.push(msg); } });
  for (const metric of Object.keys(cases[0].metrics)) {
    if (onlyMetrics.length && !onlyMetrics.includes(metric)) continue;
    const ms = cases.map((c, i) => c.metrics[metric] ?? fail(`${files[i]}: ${id} has no metric ${metric}`));
    const m0 = ms[0], bad = ms.find((m): m is Extract<Metric, { reason: string }> => m.status !== "ok");
    const stats = "value" in m0 ? ["value"] : statNames;
    for (const stat of stats) {
      const row = { scenario: id, metric, stat, unit: m0.unit } as Row;
      if (bad) {
        const candBad = ms.slice(base.length).find((m) => m.status !== "ok"), baseOk = ms.slice(0, base.length).every((m) => m.status === "ok");
        if (candBad && (candBad.status === "invalid" || baseOk)) lostMetrics.push(`${id} ${metric}: candidate is ${candBad.status}${baseOk ? " where the baseline measured it" : ""}`);
        rows.push({ ...row, verdict: bad.status, reason: bad.reason }); continue;
      }
      const vals = ms.map((m) => valueOf(m, stat as keyof Summary)!);
      row.base = side(vals.slice(0, base.length));
      if (!cand.length) { row.verdict = base.length < MIN_RUNS ? `noise floor (n<${MIN_RUNS})` : "noise floor"; rows.push(row); continue; }
      const c = row.cand = side(vals.slice(base.length)), b = row.base!;
      row.deltaPct = b.median ? ((c.median - b.median) / Math.abs(b.median)) * 100 : c.median === b.median ? 0 : Math.sign(c.median) * Infinity;
      const better = "better" in m0 ? m0.better : "lower";
      const above = c.min > b.max, below = c.max < b.min, worseDir = better === "lower" ? above : below, betterDir = better === "lower" ? below : above;
      if (b.n < MIN_RUNS || c.n < MIN_RUNS) row.verdict = `inconclusive (n<${MIN_RUNS})`;
      else if (Math.abs(row.deltaPct) < threshold) row.verdict = worseDir || betterDir ? "below threshold" : "no clear change";
      else row.verdict = worseDir ? "worse" : betterDir ? "better" : "no clear change";
      rows.push(row);
    }
  }
}

const f = (v: number) => Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3);
const range = (s: Side) => `${f(s.median)} [${f(s.min)}–${f(s.max)}] ±${s.spreadPct.toFixed(1)}%`;
const shortSha = (rs: RunResult[]) => [...new Set(rs.map((r) => (r.source.commit?.slice(0, 9) ?? "no-git") + (r.source.dirty ? "+dirty" : "")))].join(", ");
console.log(`# ${runs[0].tool}: ${base.length} baseline run(s) at ${shortSha(base)}${cand.length ? `, ${cand.length} candidate run(s) at ${shortSha(cand)}` : ""}`);
const e = runs[0].environment;
console.log(`runner: ${e.platform}/${e.arch} ${e.cpu} x${e.cpus}, node ${e.node}, gpu ${e.gpu ?? "not measured"}; threshold ${threshold}%; values are median [min–max] ±range/median over runs\n`);
console.log(cand.length ? "| scenario | metric | stat | baseline | candidate | Δ median | verdict |\n|---|---|---|---|---|---|---|" : "| scenario | metric | stat | runs | verdict |\n|---|---|---|---|---|");
for (const r of rows) {
  const what = `| ${r.scenario} | ${r.metric} (${r.unit}) | ${r.stat} |`;
  if (r.reason) console.log(`${what} ${cand.length ? "— | — | — |" : "— |"} ${r.verdict}: ${r.reason} |`);
  else if (r.cand) console.log(`${what} ${range(r.base!)} | ${range(r.cand)} | ${!Number.isFinite(r.deltaPct!) ? "from zero" : (r.deltaPct! >= 0 ? "+" : "") + r.deltaPct!.toFixed(1) + "%"} | ${r.verdict} |`);
  else console.log(`${what} ${range(r.base!)} | ${r.verdict} |`);
}
for (const w of warnings) console.log("\nwarning: " + w);
for (const g of failedGates) console.log("\nFAILED GATE: " + g);
for (const m of lostMetrics) console.log("\nUNUSABLE CANDIDATE METRIC: " + m);
const worse = rows.filter((r) => r.verdict === "worse");
if (worse.length) console.log(`\n${worse.length} regression(s) beyond ${threshold}%`);
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ threshold, stats: statNames, baseFiles, candFiles, warnings, failedGates, lostMetrics, rows }, null, 2) + "\n"); }
process.exitCode = worse.length || failedGates.length || lostMetrics.length ? 1 : 0;
