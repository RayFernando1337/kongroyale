// Tour A/B for PR #277 (?hostworker=1): n pairs of gpu-match --route tour, in-tab host (base) vs worker host (cand),
// interleaved (base,cand / cand,base ...), one at a time, then compare.mts. Run from the repo root on the PR branch,
// after npm ci and npm run build:   node <this folder>/run-ab.mjs [pairs=8] [outdir=reports/performance/hostworker-ab]
// The two arms differ only in --query hostworker=1, which gpu-match records in config.query; compare.mts refuses runs
// whose config differs, so the script writes a copy of each result with that one flag taken out of config.query
// (norm/), and keeps the originals.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const pairs = Number(process.argv[2] ?? 8), out = path.resolve(process.argv[3] ?? "reports/performance/hostworker-ab");
fs.mkdirSync(path.join(out, "norm"), { recursive: true });
const run = (arm, i) => {
  const file = path.join(out, arm + "-" + i + ".json");
  if (fs.existsSync(file)) { console.log("skip (exists) " + file); return; }
  const args = ["tsx", "tools/performance/gpu-match.mts", "--route", "tour", "--out", file, ...(arm === "cand" ? ["--query", "hostworker=1"] : [])];
  console.log(new Date().toISOString() + " " + arm + " " + i);
  const r = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) console.log("  exit " + r.status + " (kept; check its gates and errors)");
};
for (let i = 1; i <= pairs; i++) for (const arm of i % 2 ? ["base", "cand"] : ["cand", "base"]) run(arm, i);
const norm = [];
for (const f of fs.readdirSync(out).filter((f) => /^(base|cand)-\d+\.json$/.test(f))) {
  const j = JSON.parse(fs.readFileSync(path.join(out, f), "utf8"));
  j.config.query = String(j.config.query).replace(/&hostworker=1/, "");
  fs.writeFileSync(path.join(out, "norm", f), JSON.stringify(j));
  norm.push(f);
}
const files = (arm) => norm.filter((f) => f.startsWith(arm)).map((f) => path.join(out, "norm", f));
const c = spawnSync("npx", ["tsx", "tools/performance/compare.mts", "--base", ...files("base"), "--cand", ...files("cand"),
  "--metrics", "mainThreadMs,simMs,inputAckMs,frameIntervalMs,framesOver33ms,submitMs", "--stats", "p50,p95", "--out", path.join(out, "comparison.json")],
  { encoding: "utf8", shell: process.platform === "win32" });
fs.writeFileSync(path.join(out, "compare.txt"), c.stdout + c.stderr);
console.log(c.stdout + c.stderr);
