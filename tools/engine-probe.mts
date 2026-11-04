// Cross-engine probe: plays the same headless match (tools/sim-smoke.mts) under Node (V8) and Bun (JavaScriptCore) and
// prints both final-state hashes. They differ today because the engines' sin, cos, atan2, exp and pow differ in the last
// bits, the same split as a V8 server predicting a Safari client. Informational: exit 0 whether or not they match.
//   npx tsx tools/engine-probe.mts [solo|trios] [seed] [--require-match]
//   --require-match: exit 1 unless both engines ran and gave the same hash
import { spawn } from "node:child_process";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--")), requireMatch = process.argv.includes("--require-match");
const mode = args[0] === "solo" ? "solo" : "trios", seed = args[1] ?? "42";
if (!/^\d+$/.test(seed)) { console.error(`bad seed ${seed}: want a whole number`); process.exit(2); }
const shell = process.platform === "win32";
const engines: Array<[string, string, string[]]> = [
  ["node", "npx", ["tsx", "tools/sim-smoke.mts", mode, seed, "--check"]],
  ["bun", "bun", ["tools/sim-smoke.mts", mode, seed, "--check"]],
];
const run = ([name, cmd, a]: [string, string, string[]]) => new Promise<{ name: string; version: string; hash: string | null; note: string }>((done) => {
  let out = "";
  const p = spawn(cmd, a, { shell });
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("error", (e) => done({ name, version: "", hash: null, note: `could not start: ${e.message}` }));
  p.on("close", () => {
    const hash = /state hash: ([0-9a-f]{8})/.exec(out)?.[1] ?? null;
    done({ name, version: "", hash, note: hash ? "" : `no state hash in its output: ${out.trim().split("\n").slice(-3).join(" | ")}` });
  });
});
const version = (cmd: string) => new Promise<string>((done) => { let o = ""; const p = spawn(cmd, ["--version"], { shell }); p.stdout.on("data", (d) => (o += d)); p.on("error", () => done("missing")); p.on("close", () => done(o.trim() || "missing")); });
const [results, nodeV, bunV] = await Promise.all([Promise.all(engines.map(run)), version("node"), version("bun")]);
results[0].version = nodeV; results[1].version = bunV;
for (const r of results) console.log(`${r.name.padEnd(5)} ${r.version.padEnd(10)} ${mode} seed ${seed}: ${r.hash ?? "-"}${r.note ? "  (" + r.note + ")" : ""}`);
const [a, b] = results;
const same = a.hash !== null && a.hash === b.hash;
console.log(a.hash && b.hash ? (same ? "engines agree" : "engines DIFFER (expected until the sim uses deterministic math)") : "probe incomplete: an engine gave no hash");
if (requireMatch && !same) process.exit(1);
