// NET TAIL — the network tail gate. Runs tools/netlab.mts (the real client prediction and server host code over simulated
// TCP links: deterministic, so the same checkout gives the same numbers on every machine) over a matrix of weapons, path
// profiles and RTTs, with the game's two sockets (--aux), and checks every row against tools/performance/net-budgets.json.
//
//   npx tsx tools/performance/net-tail.mts [--weapons ar,shotgun] [--rtts 50,150,250] [--secs 20] [--jobs N]
//                                          [--budgets tools/performance/net-budgets.json] [--out reports/performance/net-tail.json] [--check]
//
// Report-only by default: prints one row per run and every budget it breaks, writes a kong-perf-result (schema.ts), and
// exits 0. --check exits 1 when a row breaks a budget. Metrics per row (the shooter's firing window):
//   confirmPct, ghost       predicted hits the server confirmed / rejected (what the player feels as a hit marker)
//   rttP99Ms                ping → pong
//   inputAckP99OverRttMs    input sent → the first snapshot acknowledging it, minus the path RTT: the server's own wait
//   snapGapP99Ms            time between snapshots (33 ms at 30 Hz when nothing is late)
//   corrPct                 prediction corrections per 100 snapshots, both clients
//   holdPct                 the shooter's frames that froze the target because no newer snapshot had arrived
// Runs are independent processes on a simulated clock, so --jobs (default: CPU count) changes the time taken, never
// the numbers. The netlab duel is two players on the lobby islet: it measures the link and the netcode, not a 50-player
// server under load (bench:server) or a real network (tools/performance/netpath.py, docs in tools/performance/README.md).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, env, save, source } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Gate, type RunResult } from "./schema.ts";

interface Profile { jitter: number; loss: number; why: string }
interface Budget { id: string; metric: string; max?: number; min?: number; rtt: [number, number]; profiles: string[]; why: string }
interface Config { rtts: number[]; weapons: string[]; profiles: Record<string, Profile>; budgets: Budget[] }
interface Row { weapon: string; profile: string; rtt: number; metrics: Record<string, number>; raw: Record<string, unknown> }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const budgetFile = arg("--budgets", path.join(root, "tools/performance/net-budgets.json"));
const cfg = JSON.parse(fs.readFileSync(budgetFile, "utf8")) as Config;
const list = (k: string, d: string[]) => arg(k, d.join(",")).split(",").filter(Boolean);
const weapons = list("--weapons", cfg.weapons), rtts = list("--rtts", cfg.rtts.map(String)).map(Number), secs = Number(arg("--secs", "20"));
const jobs = Math.max(1, Number(arg("--jobs", String(os.cpus().length)))), out = arg("--out", "reports/performance/net-tail.json"), check = process.argv.includes("--check");
const startedAt = new Date().toISOString(), t0 = performance.now();

function netlab(weapon: string, profile: string): Promise<Row[]> {
  const p = cfg.profiles[profile];
  const args = ["tsx", "tools/netlab.mts", rtts.join(","), "--jitter", String(p.jitter), "--loss", String(p.loss), "--aux", "--secs", String(secs), "--weapon", weapon];
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(Error(`netlab ${args.slice(2).join(" ")} exited ${code}`));
      resolve(text.split("\n").filter((l) => l.startsWith("{")).map((l) => {
        const r = JSON.parse(l);
        return { weapon, profile, rtt: r.rtt, raw: r, metrics: { confirmPct: r.confirmPct, ghost: r.ghost, rttP99Ms: r.rttMs.p99, inputAckP99OverRttMs: Math.round((r.inputAckMs.p99 - r.rtt) * 10) / 10, snapGapP99Ms: r.snapGapMs.p99, corrPct: r.corrPct, holdPct: r.holdPct } };
      }));
    });
  });
}

const tasks = weapons.flatMap((w) => Object.keys(cfg.profiles).map((p) => () => netlab(w, p)));
const rows: Row[] = [];
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => { for (let t = tasks.shift(); t; t = tasks.shift()) rows.push(...await t()); }));
const order = (r: Row) => weapons.indexOf(r.weapon) * 1e6 + Object.keys(cfg.profiles).indexOf(r.profile) * 1e3 + r.rtt;
rows.sort((a, b) => order(a) - order(b));

const breaches: string[] = [];
const cases: CaseResult[] = rows.map((r) => {
  const gates: Gate[] = cfg.budgets.filter((b) => b.profiles.includes(r.profile) && r.rtt >= b.rtt[0] && r.rtt <= b.rtt[1]).map((b) => {
    const v = r.metrics[b.metric], pass = (b.max === undefined || v <= b.max) && (b.min === undefined || v >= b.min);
    const detail = `${b.metric} ${v} (budget ${b.max !== undefined ? "≤ " + b.max : "≥ " + b.min})`;
    if (!pass) breaches.push(`${r.weapon} ${r.profile} rtt ${r.rtt}: ${b.id}: ${detail}`);
    return { id: b.id, pass, detail };
  });
  const p = cfg.profiles[r.profile];
  const ms = (value: number) => ({ status: "ok" as const, unit: "ms" as const, better: "lower" as const, value });
  return {
    scenario: { id: `net/${r.weapon}/${r.profile}/rtt${r.rtt}`, version: 1, seed: 7, workload: "synthetic-play" },
    windows: { measured: "the shooter's firing window", secs, transport: `netlab simulated TCP, 2 sockets, rtt ${r.rtt} ms, jitter ±${p.jitter / 2} ms per way, loss ${p.loss}%` },
    load: { pellets: r.raw.pellets as number, predHits: r.raw.predHits as number },
    metrics: {
      confirmPct: { status: "ok", unit: "count", better: "higher", value: r.metrics.confirmPct },
      ghost: { status: "ok", unit: "count", better: "lower", value: r.metrics.ghost },
      rttP99Ms: ms(r.metrics.rttP99Ms), inputAckP99OverRttMs: ms(r.metrics.inputAckP99OverRttMs), snapGapP99Ms: ms(r.metrics.snapGapP99Ms),
      corrPct: { status: "ok", unit: "count", better: "lower", value: r.metrics.corrPct },
      holdPct: { status: "ok", unit: "count", better: "lower", value: r.metrics.holdPct },
    },
    gates, detail: r.raw,
  };
});
const result: RunResult = { schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "net-tail", startedAt, durationMs: performance.now() - t0, source: source(root), environment: env(),
  config: { weapons: weapons.join(","), rtts: rtts.join(","), secs, profiles: Object.keys(cfg.profiles).join(","), budgets: path.relative(root, budgetFile) }, cases, errors: [], artifacts: [] };
save(out, result);

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${"weapon".padEnd(8)}${"profile".padEnd(10)}${pad("rtt", 5)}${pad("confirm%", 10)}${pad("ghost", 7)}${pad("rtt p99", 9)}${pad("ack-rtt p99", 13)}${pad("gap p99", 9)}${pad("corr%", 7)}${pad("hold%", 7)}  budgets`);
for (const c of cases) {
  const r = rows[cases.indexOf(c)], m = r.metrics, bad = c.gates.filter((g) => !g.pass).map((g) => g.id);
  console.log(`${r.weapon.padEnd(8)}${r.profile.padEnd(10)}${pad(r.rtt, 5)}${pad(m.confirmPct, 10)}${pad(m.ghost, 7)}${pad(m.rttP99Ms, 9)}${pad(m.inputAckP99OverRttMs, 13)}${pad(m.snapGapP99Ms, 9)}${pad(m.corrPct, 7)}${pad(m.holdPct, 7)}  ${c.gates.length ? (bad.length ? "OVER: " + bad.join(", ") : "ok") : "-"}`);
}
console.log(`wrote ${out}`);
if (!breaches.length) console.log(`NET TAIL: every row within budget (${cases.reduce((n, c) => n + c.gates.length, 0)} checks)`);
else {
  console.log(`NET TAIL: ${breaches.length} over budget${check ? "" : " (report-only; --check fails on these)"}:\n  ${breaches.join("\n  ")}`);
  if (check) process.exitCode = 1;
}
