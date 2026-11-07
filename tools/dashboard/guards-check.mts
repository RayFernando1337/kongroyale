// npm test's "guards" check: every check in tools/run-tests.mjs and every job in .github/workflows/ci.yml has an entry in
// tools/dashboard/guards.json, and every entry names a check that exists, so the How it's built page can't fall behind.
//   npx tsx tools/dashboard/guards-check.mts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listChecks } from "./guards-list.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const guards = JSON.parse(fs.readFileSync(path.join(here, "guards.json"), "utf8")) as { tests: Record<string, { catches?: string }>; ci: Record<string, { catches?: string }> };
const { tests, ci } = listChecks(root);
const problems: string[] = [];
for (const [kind, listed, entries] of [["check", tests, guards.tests], ["CI job", ci, guards.ci]] as const) {
  for (const c of listed) if (!entries[c.id]?.catches) problems.push(kind + " " + c.id + " has no description in tools/dashboard/guards.json: read its code and say what it catches");
  for (const id of Object.keys(entries)) if (!listed.some((c) => c.id === id)) problems.push("guards.json describes the " + kind + " " + id + ", which no longer exists");
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("guards: " + tests.length + " checks and " + ci.length + " CI jobs, all described in guards.json");
