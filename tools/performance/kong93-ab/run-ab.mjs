// Tour A/B of two builds for KONG-93 (RAY-232 culprit fixes): n interleaved pairs of gpu-match --route tour, base
// checkout vs candidate checkout, one at a time, then compare.mts. From the repo root of any up-to-date checkout:
//   node <this folder>/run-ab.mjs <base-ref> <cand-ref> [pairs=8] [outdir=reports/performance/kong93-ab]
// It makes two worktrees beside the repo (../kong-ab-base, ../kong-ab-cand) at the two refs, runs npm ci and
// npm run build in each, and serves each one's dist/ with gpu-match --root. A rerun skips results that exist.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [baseRef, candRef] = process.argv.slice(2, 4);
if (!baseRef || !candRef) throw Error("usage: run-ab.mjs <base-ref> <cand-ref> [pairs] [outdir]");
const pairs = Number(process.argv[4] ?? 8), out = path.resolve(process.argv[5] ?? "reports/performance/kong93-ab");
const win = process.platform === "win32";
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win }); if (r.status !== 0) throw Error(cmd + " " + args.join(" ") + " failed in " + cwd); };
sh("git", ["fetch", "origin"], ".");
const trees = {};
for (const [arm, ref] of [["base", baseRef], ["cand", candRef]]) {
  const dir = path.resolve("..", "kong-ab-" + arm);
  if (!fs.existsSync(dir)) sh("git", ["worktree", "add", "--detach", dir, ref], ".");
  else sh("git", ["checkout", "--detach", ref], dir);
  if (!fs.existsSync(path.join(dir, "dist", "index.html")) || process.env.REBUILD) { sh("npm", ["ci"], dir); sh("npm", ["run", "build"], dir); }
  trees[arm] = dir;
}
fs.mkdirSync(out, { recursive: true });
const run = (arm, i) => {
  const file = path.join(out, arm + "-" + i + ".json");
  if (fs.existsSync(file)) { console.log("skip (exists) " + file); return; }
  console.log(new Date().toISOString() + " " + arm + " " + i);
  const r = spawnSync("npx", ["tsx", "tools/performance/gpu-match.mts", "--root", trees[arm], "--route", "tour", "--out", file], { stdio: "inherit", shell: win });
  if (r.status !== 0) console.log("  exit " + r.status + " (kept; check its gates and errors)");
};
for (let i = 1; i <= pairs; i++) for (const arm of i % 2 ? ["base", "cand"] : ["cand", "base"]) run(arm, i);
const files = (arm) => fs.readdirSync(out).filter((f) => new RegExp("^" + arm + "-\\d+\\.json$").test(f)).map((f) => path.join(out, f));
const c = spawnSync("npx", ["tsx", "tools/performance/compare.mts", "--base", ...files("base"), "--cand", ...files("cand"),
  "--metrics", "mainThreadMs,submitMs,frameIntervalMs,framesOver33ms", "--stats", "p50,p95", "--out", path.join(out, "comparison.json")],
  { encoding: "utf8", shell: win });
fs.writeFileSync(path.join(out, "compare.txt"), c.stdout + c.stderr);
console.log(c.stdout + c.stderr);
