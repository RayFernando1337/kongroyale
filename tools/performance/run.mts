// Repeated, interleaved baseline/candidate runs of bench:host (or alloc.mts with --runner alloc), then compare.mts on the
// result files.
//   npx tsx tools/performance/run.mts --base ../kong-base --cand . --scenario real-play --metrics hostTickMs
//   npx tsx tools/performance/run.mts --runner alloc --base ../kong-base --cand . --metrics allocBytesPerTick,gcCount
//   npx tsx tools/performance/run.mts --base .                         (A/A: the same checkout on both sides)
// Each run is a fresh Node process measuring the checkout given (host.mts or alloc.mts --root), so JIT and GC state never carry
// over. Pairs alternate order (base,cand then cand,base) so machine drift falls on both sides.
// The match-state digest (and with --trace the packet checksum) must be identical across every run of one side (determinism), and between the sides unless
// --allow-outcome-change: a performance change should replay the same match.
// Options: --reps 5, --scenario real-play, --out-dir reports/performance/run-<time>, host.mts's --ticks and --trace,
// and compare.mts's --metrics,
// --stats, --threshold and --budgets, which are passed through. Exit status: compare.mts's, or 1 on a digest mismatch.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { arg } from "./common.mts";
import { parseResult } from "./schema.ts";

const here = path.dirname(fileURLToPath(import.meta.url)), harness = path.resolve(here, "../..");
const baseRoot = path.resolve(arg("--base", ".")), candRoot = path.resolve(arg("--cand", baseRoot)), aa = candRoot === baseRoot;
const reps = Number(arg("--reps", "5")), scenario = arg("--scenario", "real-play"), runner = arg("--runner", "host");
if (runner !== "host" && runner !== "alloc") throw Error(`--runner is host or alloc, not ${runner}`);
const outDir = path.resolve(arg("--out-dir", `reports/performance/run-${new Date().toISOString().replace(/[:.]/g, "-")}`));
if (!(reps >= 1)) throw Error("--reps must be at least 1");
fs.mkdirSync(outDir, { recursive: true });

const hostArgs = [...(process.argv.includes("--trace") ? ["--trace"] : []), ...(process.argv.includes("--ticks") ? ["--ticks", arg("--ticks", "")] : [])];
const tsx = (file: string, args: string[], quiet = false) => spawnSync(process.execPath, ["--import", "tsx", path.join(here, file), ...args], { cwd: harness, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
const files: Record<"base" | "cand", string[]> = { base: [], cand: [] };
for (let i = 0; i < reps; i++) {
  for (const sideName of (i % 2 ? ["cand", "base"] : ["base", "cand"]) as Array<"base" | "cand">) {
    const file = path.join(outDir, `${sideName}-${i + 1}.json`);
    console.log(`run ${i + 1}/${reps} ${sideName}${aa ? " (A/A)" : ""}: ${sideName === "base" ? baseRoot : candRoot}`);
    fs.rmSync(file, { force: true });
    const r = tsx(`${runner}.mts`, ["--root", sideName === "base" ? baseRoot : candRoot, "--scenario", scenario, "--out", file, ...hostArgs]);
    if (r.error) throw r.error;
    if (!fs.existsSync(file)) throw Error(`${runner}.mts wrote no result (exit ${r.status}); see its output above`);
    files[sideName].push(file);
  }
}

let digestFailure = false;
// With --trace the packet checksum must match too: the same final state can hide a different packet stream.
const digests = (list: string[]) => list.map((f) => Object.fromEntries(parseResult(JSON.parse(fs.readFileSync(f, "utf8")), f).cases.map((c) => [c.scenario.id, String(c.detail?.stateDigest) + (hostArgs.includes("--trace") ? "/" + String(c.detail?.packetChecksum) : "")])));
const base = digests(files.base), cand = digests(files.cand);
for (const id of Object.keys(base[0])) {
  const b = new Set(base.map((d) => d[id])), c = new Set(cand.map((d) => d[id]));
  if (b.size > 1 || c.size > 1) { digestFailure = true; console.log(`\nNONDETERMINISTIC: ${id} produced ${b.size} baseline and ${c.size} candidate match-state digests across runs`); }
  else if ([...b][0] !== [...c][0]) {
    if (!process.argv.includes("--allow-outcome-change")) digestFailure = true;
    console.log(`\n${process.argv.includes("--allow-outcome-change") ? "note" : "OUTCOME CHANGED"}: ${id} candidate replays a different match than the baseline (state digest differs)`);
  } else console.log(`\n${id}: every run replayed the same match (state digest ${[...b][0].slice(0, 12)})`);
}

const passThrough = ["--metrics", "--stats", "--threshold", "--budgets"].flatMap((flag) => {
  const i = process.argv.indexOf(flag); if (i < 0) return [];
  const values: string[] = []; for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) values.push(process.argv[j]);
  return [flag, ...values];
});
const cmp = tsx("compare.mts", ["--base", ...files.base, "--cand", ...files.cand, ...passThrough, "--out", path.join(outDir, "comparison.json")], true);
const table = (cmp.stdout ?? "") + (cmp.stderr ?? "");
fs.writeFileSync(path.join(outDir, "comparison.md"), table);
console.log("\n" + table);
console.log(`results: ${outDir}`);
process.exitCode = digestFailure ? 1 : (cmp.status ?? 1);
