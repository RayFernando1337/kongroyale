// Is a fork pull request ready to merge? Reads the PR with the gh CLI (read-only: it never merges, approves, comments,
// labels or pushes), hands what it read to tools/pr-ready/decide.mts and prints that verdict as one JSON object.
//   npx tsx tools/pr-ready.mts 123 [--repo owner/name] [--snapshot out.json] [--ray-go]
// --ray-go records that Ray said go, which a release:major PR needs before it is ready; pass it only after he has.
//   exit 0 ready, 1 not ready, 2 usage or gh error
// --snapshot also writes the gh data the verdict was decided from; tools/pr-ready/fixtures/ holds recorded ones.
// gh uses its default host and login, so it works wherever `gh auth status` does (a Capy machine talks to a mirror).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { GateError, orExit, parseFlags } from "./gate.mts";
import { BUDGETS_PATH, decide } from "./pr-ready/decide.mts";
import type { BudgetBlobs, CheckRun, CommitStatus, PrView, ReviewThread, Snapshot } from "./pr-ready/decide.mts";

const FORK = "rayfernando1337/kongroyale";
const USAGE = "npx tsx tools/pr-ready.mts <number> [--repo owner/name] [--snapshot out.json] [--ray-go]";
const MERGEABLE_READS = 5;
const MERGEABLE_WAIT_MS = 3000;
const GH_TRIES = 3;

const { flags, positional } = orExit("pr-ready", USAGE, () => parseFlags(process.argv.slice(2), { "--repo": "string", "--snapshot": "string", "--ray-go": "bool" }, { positional: true }));
const number = orExit("pr-ready", USAGE, () => {
  if (positional.length !== 1 || !/^[1-9]\d*$/.test(positional[0])) throw new GateError("give exactly one pull request number");
  return Number(positional[0]);
});
const repo = orExit("pr-ready", USAGE, () => {
  const r = flags["--repo"] ?? FORK;
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new GateError(`--repo must be owner/name, got "${r}"`);
  return r;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// GET only: gh api defaults to GET unless a field is passed, and the one POST below is a GraphQL query
const gh = async (...args: string[]): Promise<string> => {
  for (let i = 1; ; i++) {
    try { return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }).trim(); }
    catch (e: any) {
      const msg = `gh ${args.join(" ")}: ${(e.stderr || e.message).trim()}`;
      if (i >= GH_TRIES || !/HTTP 5\d\d|timeout|connection reset/i.test(msg)) throw new Error(msg);
      await sleep(2000 * i);
    }
  }
};
const ghJson = async <T,>(...args: string[]): Promise<T> => JSON.parse(await gh(...args)) as T;
// gh api --paginate --jq prints one line per page; each line here is one JSON array
const ghPages = async <T,>(...args: string[]): Promise<T[]> => (await gh(...args)).split("\n").filter(Boolean).flatMap((l) => JSON.parse(l) as T[]);
const blobAt = async (ref: string): Promise<string | null> => {
  try { return await gh("api", `repos/${repo}/contents/${BUDGETS_PATH}?ref=${ref}`, "--jq", ".sha"); }
  catch (e) { if (/HTTP 404/.test(String(e))) return null; throw e; }
};

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { isResolved isOutdated path comments(first: 1) { nodes { author { login } body url } } }
    }
  } }
}`;

async function readThreads(): Promise<ReviewThread[]> {
  const [owner, name] = repo.split("/");
  const all: ReviewThread[] = [];
  for (let after: string | null = null; ;) {
    type Page = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ReviewThread[] } } } } };
    const page: Page = await ghJson<Page>("api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, ...(after ? ["-F", `after=${after}`] : []));
    const conn = page.data.repository.pullRequest.reviewThreads;
    all.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return all;
    after = conn.pageInfo.endCursor;
  }
}

async function readSnapshot(): Promise<Snapshot> {
  const view = () => ghJson<PrView>("pr", "view", String(number), "--repo", repo, "--json", "number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,labels");
  let pr = await view(), mergeableReads = 1;
  while (pr.state === "OPEN" && (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") && mergeableReads < MERGEABLE_READS) {
    await sleep(MERGEABLE_WAIT_MS);
    pr = await view();
    mergeableReads++;
  }
  const sha = pr.headRefOid;
  const [checkRuns, statuses, threads, budgets] = await Promise.all([
    ghPages<CheckRun>("api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {id, name, status, conclusion}]"),
    ghPages<CommitStatus>("api", "--paginate", `repos/${repo}/commits/${sha}/status?per_page=100`, "--jq", "[.statuses[] | {context, state, description}]"),
    readThreads(),
    (async (): Promise<BudgetBlobs | null> => {
      if (pr.state !== "OPEN") return null;
      const cmp = await ghJson<{ mergeBase: string; base: string }>("api", `repos/${repo}/compare/${pr.baseRefName}...${sha}`, "--jq", "{mergeBase: .merge_base_commit.sha, base: .base_commit.sha}");
      const [mergeBaseBlob, baseBlob, headBlob] = await Promise.all([blobAt(cmp.mergeBase), blobAt(cmp.base), blobAt(sha)]);
      return { mergeBase: cmp.mergeBase, mergeBaseBlob, baseBlob, headBlob };
    })(),
  ]);
  return { pr, mergeableReads, checkRuns, statuses, threads, budgets, rayGo: !!flags["--ray-go"] };
}

let snapshot: Snapshot;
try { snapshot = await readSnapshot(); }
catch (e) { console.error(`pr-ready: ${e instanceof Error ? e.message : e}`); process.exit(2); }
if (flags["--snapshot"]) fs.writeFileSync(flags["--snapshot"], JSON.stringify(snapshot, null, 2) + "\n");
const verdict = decide(snapshot);
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ready ? 0 : 1);
