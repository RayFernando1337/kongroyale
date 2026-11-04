#!/usr/bin/env node
// `npm test`: every automated check that needs no GPU, no network and no database, one after another.
// Exit 0 = all passed. Run `npm run build` first (the admin red-team serves the built admin bundles).
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// reports go to a temp folder: `npm test` never changes a tracked file
const tmp = (f) => path.join(os.tmpdir(), `kong-royale-${f}`);

const checks = [
  ["types", "npx", ["tsc", "--noEmit"]],
  ["movement", "npx", ["tsx", "tools/gameplay/movetest.mts"]],
  ["swimming", "npx", ["tsx", "tools/swim/simtest.mts"]],
  ["kong face", "npx", ["tsx", "tools/actors/face-test.mts"]],
  ["kong animation", "npx", ["tsx", "tools/actors/anim-test.mts"]],
  ["building walk graph", "npx", ["tsx", "tools/buildings/walkgraph.test.mts"]],
  ["path solver", "npx", ["tsx", "tools/play/solver-tests.mts", "--json", tmp("solver-tests.json")]],
  ["glass", "npx", ["tsx", "tools/glass/test.mts"]],
  ["raycast ties", "npx", ["tsx", "tools/world/raycast-test.mts"]],
  ["wire / matrix / geometry / http / splat parity", "npm", ["run", "bench:verify"]],
  ["headless match (seed 42)", "npm", ["run", "sim"]],
  ["admin lobby red team", "node", ["tools/admin-lobby/redteam.mjs", "--md", tmp("redteam.md")]],
];

const failed = [];
for (const [name, cmd, args] of checks) {
  const t = Date.now();
  console.log(`\n▶ ${name}`);
  // npm and npx are .cmd scripts on Windows, which Node only spawns through a shell. The shell gets one command line
  // with every argument quoted, because the temp folder in the report paths can contain spaces. The command name stays
  // bare: cmd.exe starting a quoted "npx" from PATH makes %~dp0 in npx.cmd point at the current folder instead of the
  // Node install. node is a real executable, so it skips cmd.exe and its %VAR% expansion
  const r = process.platform === "win32" && cmd !== "node"
    ? spawnSync([cmd, ...args.map((a) => `"${a}"`)].join(" "), { stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { stdio: "inherit" });
  const ok = r.status === 0;
  console.log(`${ok ? "✔" : "✘"} ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  if (!ok) failed.push(name);
}
console.log(failed.length ? `\n${failed.length} failed: ${failed.join(", ")}` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
