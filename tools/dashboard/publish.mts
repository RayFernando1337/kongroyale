import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALWAYS_FORBIDDEN } from "./scan.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BRANCH = "gh-pages";
const HOSTS = ["github.com", "git.capy.ai"];

function run(cmd: string, args: string[], cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function originRepo(url: string): string | undefined {
  const scp = url.match(/^git@([^:/]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (scp) return HOSTS.includes(scp[1].toLowerCase()) ? scp[2].toLowerCase() : undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "https:" && u.protocol !== "ssh:") || !HOSTS.includes(u.hostname.toLowerCase())) return undefined;
  const repo = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[^/]+\/[^/]+$/.test(repo) ? repo.toLowerCase() : undefined;
}

function withoutStamp(html: string): string {
  return html.replace(/(<footer>Built from commit .*?<\/a>) at [^<]*?\. /, "$1. ");
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const data = JSON.parse(fs.readFileSync(path.join(HERE, "data.json"), "utf8")) as { repo: string; hide: string };
  const origin = run("git", ["remote", "get-url", "origin"]).trim();
  if (originRepo(origin) !== data.repo.toLowerCase()) throw new Error("refusing to publish: origin is not " + data.repo + " on " + HOSTS.join(" or "));
  run("git", ["fetch", "-q", "origin", "main"]);
  const sha = run("git", ["rev-parse", "HEAD"]).trim();
  if (!dryRun && sha !== run("git", ["rev-parse", "origin/main"]).trim()) throw new Error("refusing to publish: HEAD " + sha.slice(0, 7) + " is not origin/main; the page is built from the data in this checkout, so check out main at its tip first");
  if (!dryRun && run("git", ["status", "--porcelain", "--", "tools/dashboard"]).trim()) throw new Error("refusing to publish: tools/dashboard has uncommitted changes, so the page would show values the stamped commit does not contain");
  const forbidden = new RegExp(ALWAYS_FORBIDDEN + "|" + data.hide, "gi");
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "kr-dash-site-"));
  const work = path.join(os.tmpdir(), "kr-dash-pages-" + process.pid);
  const orphan = "kr-dash-pages-" + process.pid;
  let worktree = false;
  let orphanMade = false;
  try {
    run(process.execPath, ["--import", "tsx", path.join(HERE, "build.mts"), "--out", site, "--sha", sha]);
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    const hits = html.match(forbidden);
    if (hits) throw new Error("refusing to publish: forbidden words in the page: " + [...new Set(hits.map((h) => h.toLowerCase()))].join(", "));
    const files = fs.readdirSync(site);
    if (files.length !== 1 || files[0] !== "index.html") throw new Error("unexpected build output: " + files.join(", "));
    const exists = run("git", ["ls-remote", "--heads", "origin", BRANCH]).trim() !== "";
    if (exists) run("git", ["fetch", "-q", "origin", BRANCH]);
    run("git", exists ? ["worktree", "add", "-q", "--detach", work, "FETCH_HEAD"] : ["worktree", "add", "-q", "--detach", work]);
    worktree = true;
    if (!exists) {
      run("git", ["checkout", "-q", "--orphan", orphan], work);
      orphanMade = true;
    }
    const live = path.join(work, "index.html");
    const tracked = run("git", ["ls-files"], work).split("\n").filter(Boolean).sort().join(",");
    const jekyll = path.join(work, ".nojekyll");
    const clean = tracked === ".nojekyll,index.html" && fs.existsSync(jekyll) && fs.lstatSync(jekyll).isFile() && fs.readFileSync(jekyll, "utf8") === "";
    if (exists && clean && withoutStamp(fs.readFileSync(live, "utf8")) === withoutStamp(html)) {
      console.log("dashboard publish: no change");
      return;
    }
    for (const f of run("git", ["ls-files"], work).split("\n").filter(Boolean)) run("git", ["rm", "-q", "-f", f], work);
    fs.writeFileSync(live, html);
    fs.writeFileSync(jekyll, "");
    run("git", ["add", "index.html", ".nojekyll"], work);
    run("git", ["commit", "-q", "-m", "dashboard: publish " + new Date().toISOString()], work);
    if (dryRun) {
      worktree = false;
      orphanMade = false;
      console.log("dashboard publish: dry run, committed in " + work + " but not pushed. Remove it with: git worktree remove --force " + work + (exists ? "" : " && git branch -D " + orphan));
      return;
    }
    run("git", ["push", "-q", "origin", "HEAD:refs/heads/" + BRANCH], work);
    console.log("dashboard publish: pushed " + run("git", ["rev-parse", "--short", "HEAD"], work).trim() + " to " + BRANCH);
  } finally {
    if (worktree) run("git", ["worktree", "remove", "--force", work]);
    if (orphanMade) run("git", ["branch", "-q", "-D", orphan]);
    fs.rmSync(site, { recursive: true, force: true });
  }
}

main();
