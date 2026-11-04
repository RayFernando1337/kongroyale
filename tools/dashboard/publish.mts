import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BRANCH = "gh-pages";
const FORBIDDEN = /advisory|advisories|ghsa|security|lobby cap|role switch/gi;

function run(cmd: string, args: string[], cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "kr-dash-site-"));
  const work = path.join(os.tmpdir(), "kr-dash-pages-" + process.pid);
  run("npx", ["tsx", path.join(HERE, "build.mts"), "--out", site]);
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  const hits = html.match(FORBIDDEN);
  if (hits) throw new Error("refusing to publish: forbidden words in the page: " + [...new Set(hits.map((h) => h.toLowerCase()))].join(", "));
  const files = fs.readdirSync(site);
  if (files.length !== 1 || files[0] !== "index.html") throw new Error("unexpected build output: " + files.join(", "));
  const exists = run("git", ["ls-remote", "--heads", "origin", BRANCH]).trim() !== "";
  if (exists) {
    run("git", ["fetch", "-q", "origin", BRANCH]);
    run("git", ["worktree", "add", "-q", "--detach", work, "FETCH_HEAD"]);
  } else {
    run("git", ["worktree", "add", "-q", "--detach", work]);
    run("git", ["checkout", "-q", "--orphan", BRANCH], work);
  }
  try {
    for (const f of run("git", ["ls-files"], work).split("\n").filter(Boolean)) run("git", ["rm", "-q", "-f", f], work);
    fs.copyFileSync(path.join(site, "index.html"), path.join(work, "index.html"));
    fs.writeFileSync(path.join(work, ".nojekyll"), "");
    run("git", ["add", "index.html", ".nojekyll"], work);
    const staged = run("git", ["diff", "--cached", "--name-only"], work).trim();
    if (!staged && exists) {
      console.log("dashboard publish: no change");
      return;
    }
    run("git", ["commit", "-q", "-m", "dashboard: publish " + new Date().toISOString()], work);
    if (dryRun) {
      console.log("dashboard publish: dry run, committed in " + work + " but not pushed");
      return;
    }
    run("git", ["push", "-q", "origin", "HEAD:refs/heads/" + BRANCH], work);
    console.log("dashboard publish: pushed " + run("git", ["rev-parse", "--short", "HEAD"], work).trim() + " to " + BRANCH);
  } finally {
    run("git", ["worktree", "remove", "--force", work]);
    fs.rmSync(site, { recursive: true, force: true });
  }
}

main();
