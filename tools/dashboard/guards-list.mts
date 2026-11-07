// The checks every PR runs, read from the repo itself: npm test's list (tools/run-tests.mjs --list) and the jobs in
// .github/workflows/ci.yml. built.mts renders them and guards-check.mts fails npm test when guards.json misses one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ListedCheck = { id: string; slow: boolean; name: string };

export function listChecks(root: string): { tests: ListedCheck[]; ci: { id: string; name: string }[] } {
  const tests = execFileSync("node", ["tools/run-tests.mjs", "--list"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.trim()).map((l) => {
    const m = /^(\w+)\s+(slow\s+)?(.+)$/.exec(l.trim());
    if (!m) throw new Error("run-tests.mjs --list: can't read the line: " + l);
    return { id: m[1], slow: !!m[2], name: m[3] };
  });
  const yml = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  return { tests, ci: [...yml.matchAll(/^  ([\w-]+):\n    name: (.+)$/gm)].map((m) => ({ id: m[1], name: m[2] })) };
}
