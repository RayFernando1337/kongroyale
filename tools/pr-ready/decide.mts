// The merge-ready verdict for one fork pull request, decided from what gh returned and nothing else: no I/O, no clock,
// so tools/pr-ready/decide.test.mts can feed it recorded gh JSON. tools/pr-ready.mts gathers the Snapshot with gh and
// prints the Verdict. Each item answers one question the Captain asks before merging, with a reason a person can act on.

/** Every job in .github/workflows/ci.yml, by its check-run name (one per arm of a matrix job). Each runs on every pull request, so a missing or
 *  skipped one is never normal; decide.test.mts fails when this list and ci.yml disagree. */
export const REQUIRED_CHECKS: readonly string[] = [
  "build and test",
  "no secrets",
  "TLA+ models",
  "no-GPU boot smoke",
  "no-GPU match-to-match memory",
  "no-GPU low-memory memory",
  "no-GPU context restore",
  "no-GPU invariants (lowmem)",
  "no-GPU invariants (default)",
];

/** The commit status Capy's reviewer posts on each commit it reviews. Its description counts the open non-note
 *  findings ("Capy found no issues", "Capy found 2 potential issues (1 medium, 1 low)") and is reposted when a finding
 *  is triaged, so it is the one place gh can see the findings' state. */
export const CAPY_STATUS = "capy/review";

export const BUDGETS_PATH = "tools/size-budgets.json";

/** The labels `tools/release.mts cut` needs on every merged PR: one bump, one section (.agents/skills/release/SKILL.md). */
export const BUMP_LABELS: readonly string[] = ["release:patch", "release:minor", "release:major"];
export const SECTION_LABELS: readonly string[] = ["section:features", "section:performance", "section:fixes", "section:tooling", "section:docs"];

/** `gh pr view --json number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,labels` */
export interface PrView {
  number: number;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  labels: { name: string }[];
}

/** One check run on the head commit (`commits/{sha}/check-runs`), id/name/status/conclusion only. */
export interface CheckRun { id: number; name: string; status: string; conclusion: string | null }

/** The latest status per context on the head commit (`commits/{sha}/status`). */
export interface CommitStatus { context: string; state: string; description: string | null }

/** One node of the GraphQL `reviewThreads` connection, with its first comment. */
export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  comments: { nodes: { author: { login: string } | null; body: string; url: string }[] };
}

/** Git blob ids of tools/size-budgets.json (null where the file is absent) at the merge base of the PR head and its
 *  base branch, at the base branch's tip and at the PR head. */
export interface BudgetBlobs { mergeBase: string; mergeBaseBlob: string | null; baseBlob: string | null; headBlob: string | null }

export interface Snapshot {
  pr: PrView;
  /** how many times mergeability was read; GitHub answers UNKNOWN while it is still computing */
  mergeableReads: number;
  checkRuns: CheckRun[];
  statuses: CommitStatus[];
  threads: ReviewThread[];
  /** null when the PR is not open: there is nothing left to merge, so the drift check is not run */
  budgets: BudgetBlobs | null;
}

export interface Item { id: "checks" | "capy-review" | "threads" | "mergeable" | "base" | "size-budget-drift" | "labels"; ok: boolean; reason: string }
export interface Verdict { pr: number; head: string; ready: boolean; items: Item[] }

const OK_CONCLUSIONS = ["success", "neutral", "skipped"];
const short = (sha: string) => sha.slice(0, 7);

function checks(s: Snapshot): Item {
  const latest = new Map<string, CheckRun>();
  for (const run of s.checkRuns) {
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }
  const missing = REQUIRED_CHECKS.filter((name) => !latest.has(name));
  const pending: string[] = [], failed: string[] = [];
  for (const run of latest.values()) {
    const required = REQUIRED_CHECKS.includes(run.name);
    if (run.status !== "completed") pending.push(`${run.name} (${run.status})`);
    else if (required ? run.conclusion !== "success" : !OK_CONCLUSIONS.includes(run.conclusion ?? "")) failed.push(`${run.name} (${run.conclusion})`);
  }
  for (const st of s.statuses) {
    if (st.state === "pending") pending.push(`${st.context} (pending)`);
    else if (st.state !== "success") failed.push(`${st.context} (${st.state})`);
  }
  const problems = [
    failed.length ? `failed: ${failed.join(", ")}` : "",
    pending.length ? `pending: ${pending.join(", ")}` : "",
    missing.length ? `missing required CI checks: ${missing.join(", ")} (ci.yml on main runs them; merge main if this head predates one)` : "",
  ].filter(Boolean);
  if (problems.length) return { id: "checks", ok: false, reason: `on ${short(s.pr.headRefOid)}: ${problems.join("; ")}` };
  const others = [...latest.keys()].filter((n) => !REQUIRED_CHECKS.includes(n));
  return {
    id: "checks",
    ok: true,
    reason: `on ${short(s.pr.headRefOid)}: all ${REQUIRED_CHECKS.length} required CI checks passed (${REQUIRED_CHECKS.join(", ")})`
      + (others.length ? `, plus ${others.join(", ")}` : "")
      + (s.statuses.length ? `; statuses passed: ${s.statuses.map((x) => x.context).join(", ")}` : ""),
  };
}

function capyReview(s: Snapshot): Item {
  const head = short(s.pr.headRefOid);
  const st = s.statuses.find((x) => x.context === CAPY_STATUS);
  const desc = st?.description ?? "";
  const no = (reason: string): Item => ({ id: "capy-review", ok: false, reason });
  if (!st) return no(`no ${CAPY_STATUS} status on ${head}: Capy has not reviewed this head; push an empty commit to retrigger`);
  if (st.state === "pending") return no(`Capy is still reviewing ${head} ("${desc}")`);
  if (st.state !== "success") return no(`Capy's review of ${head} ended in ${st.state} ("${desc}"); push an empty commit to retrigger`);
  if (/^Capy found no issues\b/.test(desc)) return { id: "capy-review", ok: true, reason: `Capy's review of ${head} completed: "${desc}" (0 open non-note findings, as counted by the ${CAPY_STATUS} status)` };
  if (/^Capy found \d+ potential issues?\b/.test(desc)) return no(`Capy's review of ${head} completed with open findings: "${desc}"; fix or triage them (tools.pr.getFindings) and the status updates`);
  return no(`unrecognised ${CAPY_STATUS} description on ${head}: "${desc}"; read the findings in Capy`);
}

function threads(s: Snapshot): Item {
  const open = s.threads.filter((t) => !t.isResolved);
  if (!open.length) return { id: "threads", ok: true, reason: `0 unresolved of ${s.threads.length} review threads` };
  const named = open.map((t) => {
    const first = t.comments.nodes[0];
    const title = first?.body.split("\n").find((l) => l.trim() && !l.startsWith("<!--"))?.replace(/^#+\s*|\*\*/g, "").slice(0, 80) ?? "";
    return `${t.path} by ${first?.author?.login ?? "?"}${t.isOutdated ? " (outdated)" : ""}: ${title} ${first?.url ?? ""}`.trim();
  });
  return { id: "threads", ok: false, reason: `${open.length} unresolved of ${s.threads.length} review threads: ${named.join(" | ")}` };
}

function mergeable(s: Snapshot): Item {
  const { state, isDraft, mergeable: m, mergeStateStatus: ms, baseRefName } = s.pr;
  const no = (reason: string): Item => ({ id: "mergeable", ok: false, reason });
  if (state !== "OPEN") return no(`the PR is ${state}`);
  if (isDraft) return no("the PR is a draft");
  if (m === "CONFLICTING" || ms === "DIRTY") return no(`conflicts with ${baseRefName} (mergeable=${m}, mergeStateStatus=${ms}): merge or rebase onto origin/${baseRefName}`);
  if (ms === "BLOCKED") return no(`GitHub blocks the merge (mergeable=${m}, mergeStateStatus=BLOCKED): a required check or approval is missing`);
  if (m === "UNKNOWN" || ms === "UNKNOWN") return no(`GitHub is still computing mergeability (mergeable=${m}, mergeStateStatus=${ms} after ${s.mergeableReads} reads); run again in a minute`);
  return { id: "mergeable", ok: true, reason: `mergeable=${m}, mergeStateStatus=${ms}` };
}

function base(s: Snapshot): Item {
  const ok = s.pr.baseRefName === "main";
  return { id: "base", ok, reason: ok ? "base is main" : `base is ${s.pr.baseRefName}, not main` };
}

function budgetDrift(s: Snapshot): Item {
  const b = s.budgets;
  if (!b) return { id: "size-budget-drift", ok: false, reason: `not checked: the PR is ${s.pr.state}` };
  const baseChanged = b.baseBlob !== b.mergeBaseBlob, prChanged = b.headBlob !== b.mergeBaseBlob;
  const since = `since the merge base ${short(b.mergeBase)}`;
  if (baseChanged && prChanged) return { id: "size-budget-drift", ok: false, reason: `${s.pr.baseRefName} changed ${BUDGETS_PATH} ${since} and this PR changes it too: merge main first, then re-measure` };
  return { id: "size-budget-drift", ok: true, reason: prChanged ? `this PR changes ${BUDGETS_PATH}; ${s.pr.baseRefName} has not ${since}` : `this PR does not change ${BUDGETS_PATH}` };
}

function labels(s: Snapshot): Item {
  const names = s.pr.labels.map((l) => l.name);
  const bumps = names.filter((n) => BUMP_LABELS.includes(n)), sections = names.filter((n) => SECTION_LABELS.includes(n));
  const no = (reason: string): Item => ({ id: "labels", ok: false, reason });
  if (bumps.length !== 1) return no(`needs exactly one of ${BUMP_LABELS.join(", ")} (has ${bumps.join(", ") || "none"}); release.mts cut refuses unlabelled PRs`);
  if (sections.length !== 1) return no(`needs exactly one of ${SECTION_LABELS.join(", ")} (has ${sections.join(", ") || "none"}); release.mts cut refuses unlabelled PRs`);
  if (bumps[0] === "release:major") return no("release:major needs Ray's go before it merges, and gh has no record of that: a person makes this merge, not this check");
  return { id: "labels", ok: true, reason: `${bumps[0]}, ${sections[0]}` };
}

export function decide(s: Snapshot): Verdict {
  const items = [checks(s), capyReview(s), threads(s), mergeable(s), base(s), budgetDrift(s), labels(s)];
  return { pr: s.pr.number, head: s.pr.headRefOid, ready: items.every((i) => i.ok), items };
}
