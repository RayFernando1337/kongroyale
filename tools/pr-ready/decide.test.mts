// Fixture test for tools/pr-ready/decide.mts: recorded gh snapshots of real fork PRs (tools/pr-ready/fixtures/, written
// by `npx tsx tools/pr-ready.mts <n> --snapshot`) and edited copies of them must give the expected verdicts, and
// REQUIRED_CHECKS must name exactly the jobs in .github/workflows/ci.yml. No network: npm test runs it as "prready".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPY_STATUS, REQUIRED_CHECKS, decide } from "./decide.mts";
import type { Item, Snapshot } from "./decide.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (n: number): Snapshot => JSON.parse(fs.readFileSync(path.join(here, "fixtures", `pr-${n}.json`), "utf8"));
const item = (s: Snapshot, id: Item["id"]) => {
  const found = decide(s).items.find((i) => i.id === id);
  assert.ok(found, id);
  return found;
};
const expectItem = (s: Snapshot, id: Item["id"], ok: boolean, reason: RegExp, what: string) => {
  const i = item(s, id);
  assert.equal(i.ok, ok, `${what}: ${id} ok should be ${ok}: ${i.reason}`);
  assert.match(i.reason, reason, what);
};
const okMap = (s: Snapshot) => Object.fromEntries(decide(s).items.map((i) => [i.id, i.ok]));

// recorded snapshots
const ready = load(287);
const v = decide(ready);
assert.deepEqual(Object.keys(v), ["pr", "head", "ready", "items"]);
assert.deepEqual(v.items.map((i) => i.id), ["checks", "capy-review", "threads", "mergeable", "base", "size-budget-drift", "labels"]);
assert.equal(v.pr, 287);
assert.equal(v.head, "e845d35b6014ed4aed23b4afa73cf84bc6b238a7");
assert.equal(v.ready, true, JSON.stringify(v, null, 2));
for (const i of v.items) assert.ok(i.reason.length > 0, i.id);
expectItem(ready, "size-budget-drift", true, /this PR changes tools\/size-budgets\.json; main has not/, "#287 budgets");

assert.deepEqual(okMap(load(288)), { checks: true, "capy-review": true, threads: true, mergeable: false, base: true, "size-budget-drift": false, labels: true }, "#288 merged");
expectItem(load(288), "mergeable", false, /MERGED/, "#288");

const withFinding = load(285);
assert.equal(decide(withFinding).ready, false);
expectItem(withFinding, "capy-review", false, /1 potential issue \(1 medium\)/, "#285 open Capy finding");
expectItem(withFinding, "threads", false, /^2 unresolved of 2 review threads: \.github\/workflows\/perf\.yml by devin-ai-integration/, "#285 threads");
expectItem(withFinding, "checks", true, /plus host tick A\/B/, "#285 extra check run");

expectItem(load(290), "checks", false, /^on 4b6ee01: pending: .*build and test \(in_progress\)/, "#290 CI running");

const stale = load(279);
assert.deepEqual(okMap(stale), { checks: false, "capy-review": true, threads: true, mergeable: false, base: true, "size-budget-drift": false, labels: true }, "#279 conflicting");
expectItem(stale, "checks", false, /missing required CI checks: build and test, no secrets/, "#279 no CI on a conflicting head");
expectItem(stale, "size-budget-drift", false, /main changed tools\/size-budgets\.json since the merge base cd7d105 and this PR changes it too: merge main first/, "#279 drift");

// edited copies of the ready snapshot
const edit = (fn: (s: Snapshot) => void): Snapshot => {
  const s = structuredClone(ready);
  fn(s);
  return s;
};
const run = (s: Snapshot, name: string) => {
  const r = s.checkRuns.find((x) => x.name === name);
  assert.ok(r, name);
  return r;
};

expectItem(edit((s) => { s.checkRuns = []; }), "checks", false, /missing required CI checks/, "a Devin-and-Capy-only green is not CI");
expectItem(edit((s) => { s.checkRuns = s.checkRuns.filter((r) => r.name !== "no secrets"); }), "checks", false, /missing required CI checks: no secrets \(/, "one job missing");
expectItem(edit((s) => { Object.assign(run(s, "build and test"), { status: "queued", conclusion: null }); }), "checks", false, /pending: build and test \(queued\)/, "queued");
expectItem(edit((s) => { run(s, "no-GPU boot smoke").conclusion = "skipped"; }), "checks", false, /failed: no-GPU boot smoke \(skipped\)/, "a skipped required job");
expectItem(edit((s) => { run(s, "build and test").conclusion = "failure"; }), "checks", false, /failed: build and test \(failure\)/, "failure");
expectItem(edit((s) => { s.checkRuns.push({ id: 1, name: "labeler", status: "completed", conclusion: "skipped" }); }), "checks", true, /plus labeler/, "an optional skipped run");
expectItem(edit((s) => { s.checkRuns.push({ id: 1, name: "labeler", status: "completed", conclusion: "cancelled" }); }), "checks", false, /failed: labeler \(cancelled\)/, "an optional cancelled run");
expectItem(edit((s) => { s.checkRuns.push({ ...run(s, "build and test"), id: 1, conclusion: "cancelled" }); }), "checks", true, /all 6 required/, "an older cancelled attempt under a newer pass");
expectItem(edit((s) => { s.checkRuns.push({ ...run(s, "build and test"), id: Number.MAX_SAFE_INTEGER, conclusion: "failure" }); }), "checks", false, /failed: build and test \(failure\)/, "a newer failing attempt");
expectItem(edit((s) => { s.statuses.push({ context: "Devin Review", state: "pending", description: null }); s.statuses = s.statuses.slice(1); }), "checks", false, /pending: Devin Review/, "pending status");

const capy = (state: string, description: string | null) => edit((s) => { s.statuses = s.statuses.map((x) => (x.context === CAPY_STATUS ? { ...x, state, description } : x)); });
expectItem(edit((s) => { s.statuses = s.statuses.filter((x) => x.context !== CAPY_STATUS); }), "capy-review", false, /no capy\/review status on e845d35: .*push an empty commit/, "no review on the head");
expectItem(capy("pending", "Capy is reviewing this pull request"), "capy-review", false, /still reviewing/, "review running");
expectItem(capy("error", "LLM.Error.RateLimit"), "capy-review", false, /ended in error .*push an empty commit/, "review failed");
expectItem(capy("success", "Capy found 2 potential issues (1 medium, 1 low)"), "capy-review", false, /open findings/, "findings");
expectItem(capy("success", "Capy found 1 potential issue (1 low)"), "capy-review", false, /open findings/, "one finding");
expectItem(capy("success", "Capy reviewed"), "capy-review", false, /unrecognised/, "unknown wording never passes");

expectItem(edit((s) => { s.threads[0].isResolved = false; }), "threads", false, /^1 unresolved of 7 review threads: /, "an unresolved thread");

expectItem(edit((s) => { Object.assign(s.pr, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }); s.mergeableReads = 5; }), "mergeable", false, /still computing mergeability .*after 5 reads/, "unknown");
expectItem(edit((s) => { s.pr.mergeStateStatus = "DIRTY"; }), "mergeable", false, /conflicts with main/, "dirty");
expectItem(edit((s) => { s.pr.mergeable = "CONFLICTING"; }), "mergeable", false, /conflicts with main/, "conflicting");
expectItem(edit((s) => { s.pr.mergeStateStatus = "BEHIND"; }), "mergeable", true, /BEHIND/, "behind main is still mergeable");
expectItem(edit((s) => { s.pr.isDraft = true; }), "mergeable", false, /draft/, "draft");
expectItem(edit((s) => { s.pr.mergeStateStatus = "BLOCKED"; }), "mergeable", false, /blocks the merge .*required check or approval/, "blocked by a required check or approval");

expectItem(ready, "labels", true, /^release:minor, section:performance$/, "#287 labels");
expectItem(edit((s) => { s.pr.labels = []; }), "labels", false, /exactly one of release:patch.*has none/, "unlabelled");
expectItem(edit((s) => { s.pr.labels = [{ name: "release:patch" }]; }), "labels", false, /exactly one of section:features.*has none/, "no section");
expectItem(edit((s) => { s.pr.labels.push({ name: "release:patch" }); }), "labels", false, /has release:minor, release:patch/, "two bumps");
expectItem(edit((s) => { s.pr.labels = [{ name: "release:major" }, { name: "section:features" }, { name: "bug" }]; }), "labels", false, /needs Ray's go/, "major");

expectItem(edit((s) => { s.pr.baseRefName = "next"; }), "base", false, /base is next, not main/, "base");

const budgets = (mergeBaseBlob: string | null, baseBlob: string | null, headBlob: string | null) => edit((s) => { s.budgets = { mergeBase: "abcdef0123", mergeBaseBlob, baseBlob, headBlob }; });
expectItem(budgets("a", "b", "c"), "size-budget-drift", false, /merge main first/, "both changed");
expectItem(budgets("a", "b", "b"), "size-budget-drift", false, /merge main first/, "both changed the same way");
expectItem(budgets("a", "b", "a"), "size-budget-drift", true, /does not change/, "only main changed");
expectItem(budgets("a", "a", "c"), "size-budget-drift", true, /main has not/, "only the PR changed");
expectItem(budgets(null, "a", "b"), "size-budget-drift", false, /merge main first/, "both added the file");

// REQUIRED_CHECKS is every ci.yml job name: a job's name sits at four spaces under jobs:, a step's deeper
const ci = fs.readFileSync(path.join(here, "../../.github/workflows/ci.yml"), "utf8");
const jobs = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
assert.deepEqual([...jobs].sort(), [...REQUIRED_CHECKS].sort(), "REQUIRED_CHECKS in tools/pr-ready/decide.mts must list every job in .github/workflows/ci.yml");

console.log("pr-ready: decisions match the recorded and edited snapshots");
