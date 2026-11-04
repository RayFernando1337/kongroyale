// Fork release tooling: plan, cut, promote and rollback for kong-vX.Y.Z releases on the fork. Zero dependencies; it shells
// out to git, gh and npm. A cut checks the release commit's CI, rebuilds it and publishes; run npm test yourself first. Every command takes --dry-run and is safe to re-run: a command that has nothing left to do says
// so and exits 0. See docs/RELEASING.md for the workflow and the design behind the bump rules.
//   npx tsx tools/release.mts plan                          merged PRs since the last release, next version, notes
//   npx tsx tools/release.mts cut [--hotfix-from <tag>]     test, tag, build, publish a prerelease, move "next"
//   npx tsx tools/release.mts promote <tag>                 move "stable" to a release that passed the GPU smokes
//   npx tsx tools/release.mts rollback [--to <tag>]         move "stable" back one release (or to --to)
// Options: --dry-run, --prefix <p> (tag prefix, default "kong"; any other prefix uses <p>-next and <p>-stable so a
// trial never touches the real channels), --allow-unlabelled (cut with PRs that lack a release: label).
// It only ever talks to the fork; it refuses to run against any other repository.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORK = "rayfernando1337/kongroyale";
const BASE_VERSION = "0.2.0";
const BASE_AFTER = "2026-11-03T02:32:49Z"; // upstream v0.2.0's commit time; the fork has no tag for it
const SECTIONS = [
  ["features", "Features"],
  ["performance", "Performance"],
  ["fixes", "Fixes"],
  ["tooling", "Tooling and tests"],
  ["docs", "Docs"],
] as const;
const BUMPS = ["patch", "minor", "major"] as const;
type Bump = (typeof BUMPS)[number];
const FORBIDDEN = /advisor|GHSA|CVE-\d|lobby.?cap/i;

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const dry = flag("--dry-run");
const prefix = opt("--prefix") ?? "kong";
const [cmd, ...pos] = argv.filter((a, i) => !a.startsWith("--") && !["--prefix", "--hotfix-from", "--to"].includes(argv[i - 1] ?? ""));
const tagPrefix = prefix + "-v";
const channel = (n: "next" | "stable") => (prefix === "kong" ? n : prefix + "-" + n);

const die = (m: string): never => { console.error("release: " + m); process.exit(1); };
const run = (c: string, a: string[], o: { allowFail?: boolean; cwd?: string } = {}): string => {
  try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: o.cwd, maxBuffer: 1 << 28 }).trim(); }
  catch (e: any) { if (o.allowFail) return ""; throw new Error(c + " " + a.join(" ") + ": " + (e.stderr || e.message)); }
};
const git = (...a: string[]) => run("git", a);
const gh = (...a: string[]) => run("gh", a);
const ghJson = (...a: string[]) => JSON.parse(gh(...a) || "null");
const say = (m: string) => console.log((dry ? "[dry-run] " : "") + m);

const repo = (ghJson("repo", "view", "--json", "nameWithOwner") as { nameWithOwner: string }).nameWithOwner;
if (repo.toLowerCase() !== FORK) die("refusing to run against " + repo + "; this tool only publishes to " + FORK);

interface Pr { number: number; title: string; bump?: Bump; section?: string }
interface Rel { tag: string; version: number[]; sha: string }

const parse = (tag: string) => tag.slice(tagPrefix.length).split(".").map(Number);
const cmpV = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fmt = (v: number[]) => v.join(".");

const refSha = (name: string): string | undefined => {
  const out = run("gh", ["api", "repos/" + repo + "/git/ref/tags/" + name, "--jq", ".object | .type + \" \" + .sha"], { allowFail: true });
  if (!out) return undefined;
  const [type, sha] = out.split(" ");
  return type === "tag" ? gh("api", "repos/" + repo + "/git/tags/" + sha, "--jq", ".object.sha") : sha;
};

/** Every release tag of this prefix, oldest first, with the commit each points at. */
const releases = (): Rel[] => {
  const refs = ghJson("api", "--paginate", "repos/" + repo + "/git/matching-refs/tags/" + tagPrefix, "--jq", "[.[] | .ref]") as string[] | null;
  return (refs ?? []).map((r) => r.replace("refs/tags/", "")).filter((t) => /^.+-v\d+\.\d+\.\d+$/.test(t))
    .map((tag) => ({ tag, version: parse(tag), sha: refSha(tag)! })).sort((a, b) => cmpV(a.version, b.version));
};

const loadMap = (): Record<string, number> => {
  const f = new URL("./release/upstream.json", import.meta.url);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
};

const prInfo = (n: number): Pr => {
  const p = ghJson("pr", "view", String(n), "--json", "number,title,labels") as { number: number; title: string; labels: { name: string }[] };
  const names = p.labels.map((l) => l.name);
  const bumps = names.filter((l) => l.startsWith("release:")).map((l) => l.slice(8)) as Bump[];
  const bump = bumps.length ? BUMPS[Math.max(...bumps.map((b) => BUMPS.indexOf(b)))] : undefined;
  const found = names.find((l) => l.startsWith("section:"))?.slice(8);
  const section = SECTIONS.some(([k]) => k === found) ? found : undefined;
  return { number: p.number, title: p.title, bump, section };
};

/** The PRs a release covers: with no base release, everything merged after upstream v0.2.0; else the commits base..target. */
const collect = (base: Rel | undefined, target: string): { prs: Pr[]; loose: string[] } => {
  if (!base) {
    const merged = ghJson("pr", "list", "--state", "merged", "--base", "main", "--limit", "500", "--json", "number,mergedAt") as { number: number; mergedAt: string }[];
    const until = git("log", "-1", "--format=%cI", target);
    return { prs: merged.filter((p) => p.mergedAt > BASE_AFTER && new Date(p.mergedAt) <= new Date(until)).map((p) => p.number).sort((a, b) => a - b).map(prInfo), loose: [] };
  }
  git("fetch", "--quiet", "origin", base.sha);
  const nums = new Set<number>(), loose: string[] = [];
  for (const line of git("log", "--format=%h %s", base.sha + ".." + target).split("\n").filter(Boolean)) {
    const m = /\(#(\d+)\)\s*$/.exec(line);
    if (m) nums.add(Number(m[1])); else loose.push(line);
  }
  return { prs: [...nums].sort((a, b) => a - b).map(prInfo), loose };
};

const bumpOf = (prs: Pr[], hotfix: boolean): Bump => hotfix ? "patch" : prs.reduce<Bump>((b, p) => BUMPS.indexOf(p.bump ?? "patch") > BUMPS.indexOf(b) ? (p.bump ?? "patch") : b, "patch");
const nextVersion = (base: number[], bump: Bump) =>
  bump === "major" ? [base[0] + 1, 0, 0] : bump === "minor" ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1];

const notes = (version: string, bump: Bump, prs: Pr[], loose: string[], base: string): string => {
  const up = loadMap();
  const lines = ["Kong Royale " + version + " (" + bump + "), the fork's release since " + base + ". Published to next; it moves to stable after the GPU smokes pass.", ""];
  for (const [key, title] of SECTIONS) {
    const mine = prs.filter((p) => (p.section ?? "fixes") === key);
    if (!mine.length) continue;
    lines.push("## " + title, "");
    for (const p of mine) {
      const u = up[String(p.number)];
      lines.push("- #" + p.number + " " + p.title + " (" + (u ? "[upstream #" + u + "](https://github.com/MaximilianHansen/kongroyale/pull/" + u + ")" : "fork only") + ")");
    }
    lines.push("");
  }
  if (loose.length) lines.push("## Other commits", "", ...loose.map((l) => "- " + l), "");
  return lines.join("\n");
};

const checkNotes = (text: string) => { const m = FORBIDDEN.exec(text); if (m) die("release notes contain " + JSON.stringify(m[0]) + "; remove it from the PR title or the mapping before publishing"); };

const moveTag = (name: string, sha: string) => {
  const cur = refSha(name);
  if (cur === sha) return say(name + " already at " + sha.slice(0, 7));
  say("move " + name + " " + (cur ? cur.slice(0, 7) : "(new)") + " -> " + sha.slice(0, 7));
  if (dry) return;
  if (cur) gh("api", "-X", "PATCH", "repos/" + repo + "/git/refs/tags/" + name, "-f", "sha=" + sha, "-F", "force=true");
  else gh("api", "-X", "POST", "repos/" + repo + "/git/refs", "-f", "ref=refs/tags/" + name, "-f", "sha=" + sha);
};

const isPre = (tag: string) => gh("release", "view", tag, "--json", "isPrerelease", "--jq", ".isPrerelease") === "true";
const releaseExists = (tag: string) => !!run("gh", ["release", "view", tag, "--json", "tagName", "--jq", ".tagName"], { allowFail: true });

const ciGreen = (sha: string) => {
  const runs = ghJson("api", "repos/" + repo + "/commits/" + sha + "/check-runs", "--jq", "[.check_runs[] | {name, status, conclusion}]") as { name: string; status: string; conclusion: string }[];
  const bad = runs.filter((r) => r.status !== "completed" || !["success", "skipped", "neutral"].includes(r.conclusion));
  if (!runs.length) die("no CI checks found for " + sha.slice(0, 7));
  if (bad.length) die("CI is not green on " + sha.slice(0, 7) + ": " + bad.map((r) => r.name + " " + (r.conclusion || r.status)).join(", "));
};

const plan = (hotfixFrom?: string) => {
  const all = releases();
  const target = git("rev-parse", "HEAD");
  const isAncestor = (sha: string) => { try { git("fetch", "--quiet", "origin", sha); git("merge-base", "--is-ancestor", sha, target); return true; } catch { return false; } };
  const hotBase = hotfixFrom ? all.find((r) => r.tag === hotfixFrom) ?? die("unknown release " + hotfixFrom) : undefined;
  const tagged = all.find((r) => r.sha === target);
  const from = tagged ? all[all.indexOf(tagged) - 1] : hotBase ?? [...all].reverse().find((r) => isAncestor(r.sha));
  const { prs, loose } = collect(from, target);
  const bump = tagged ? "patch" : bumpOf(prs, !!hotfixFrom);
  const sameLine = hotBase ? all.filter((r) => r.version[0] === hotBase.version[0] && r.version[1] === hotBase.version[1]) : [];
  const version = tagged ? tagged.version : nextVersion(sameLine.length ? sameLine[sameLine.length - 1].version : from?.version ?? parse(tagPrefix + BASE_VERSION), bump);
  return { target, tagged, latest: all[all.length - 1], from, prs, loose, bump: bump as Bump, version: fmt(version), tag: tagPrefix + fmt(version) };
};

if (cmd === "plan") {
  const p = plan();
  if (p.tagged) say("HEAD is already released as " + p.tagged.tag);
  else if (!p.prs.length && !p.loose.length) say("nothing unreleased since " + (p.from?.tag ?? "v" + BASE_VERSION));
  else say("next release: " + p.tag + " (" + p.bump + "), " + p.prs.length + " PRs since " + (p.from?.tag ?? "v" + BASE_VERSION));
  const unl = p.prs.filter((x) => !x.bump || !x.section);
  if (unl.length) console.log("\nUNLABELLED (counted as patch/fixes):\n" + unl.map((x) => "  #" + x.number + " " + x.title + " [bump " + (x.bump ?? "-") + ", section " + (x.section ?? "-") + "]").join("\n"));
  console.log("\n" + notes(p.tag, p.bump, p.prs, p.loose, p.from?.tag ?? "v" + BASE_VERSION));
} else if (cmd === "cut") {
  const hotfix = opt("--hotfix-from");
  const p = plan(hotfix);
  if (p.tagged && releaseExists(p.tagged.tag)) { say(p.tagged.tag + " is already released; nothing to do"); if (p.latest.tag === p.tagged.tag) moveTag(channel("next"), p.target); process.exit(0); }
  if (!p.tagged && !p.prs.length && !p.loose.length) { say("nothing unreleased; nothing to do"); process.exit(0); }
  const unl = p.prs.filter((x) => !x.bump || !x.section);
  if (unl.length && !flag("--allow-unlabelled")) die("unlabelled PRs: " + unl.map((x) => "#" + x.number).join(", ") + " (add release: and section: labels, or pass --allow-unlabelled)");
  if (hotfix && !p.from) die("hotfix base missing");
  const taken = releases().find((r) => r.tag === p.tag);
  if (taken && taken.sha !== p.target) die(p.tag + " already exists at " + taken.sha.slice(0, 7) + ", not " + p.target.slice(0, 7));
  if (hotfix) { git("fetch", "--quiet", "origin", p.from!.sha); try { git("merge-base", "--is-ancestor", p.from!.sha, "HEAD"); } catch { die("HEAD does not descend from " + hotfix + "; branch the hotfix from that tag"); } }
  if (!run("git", ["branch", "-r", "--contains", p.target], { allowFail: true })) die("HEAD " + p.target.slice(0, 7) + " is not on any pushed branch");
  if (!hotfix && prefix === "kong") { git("fetch", "--quiet", "origin", "main"); if (git("rev-parse", "origin/main") !== p.target) die("HEAD is not origin/main; check out main at its tip (or use --hotfix-from)"); }
  if (git("status", "--porcelain")) die("working tree is not clean (the build would include uncommitted or untracked files)");
  const body = notes(p.tag, hotfix ? "patch" : p.bump, p.prs, p.loose, p.from?.tag ?? "v" + BASE_VERSION);
  checkNotes(body);
  say("release " + p.tag + " at " + p.target.slice(0, 7) + " (" + p.bump + ", " + p.prs.length + " PRs)");
  if (!dry) ciGreen(p.target); else say("would require CI green on " + p.target.slice(0, 7));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kong-release-"));
  const tarball = path.join(tmp, p.tag + "-dist.tar.gz");
  if (dry) say("would run npm run build and attach " + path.basename(tarball));
  else {
    execFileSync("npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
    const dirs = ["dist", "dist-admin"].filter((d) => fs.existsSync(d));
    run("tar", ["-czf", tarball, ...dirs]);
  }
  fs.writeFileSync(path.join(tmp, "notes.md"), body);
  if (dry) say("would publish prerelease " + p.tag + " with " + body.split("\n").length + " lines of notes");
  else if (!releaseExists(p.tag)) gh("release", "create", p.tag, tarball, "--target", p.target, "--title", "Kong Royale " + p.version, "--notes-file", path.join(tmp, "notes.md"), "--prerelease");
  else gh("release", "upload", p.tag, tarball, "--clobber");
  if (!dry) say("published " + p.tag + ": " + gh("release", "view", p.tag, "--json", "url", "--jq", ".url"));
  moveTag(channel("next"), p.target);
} else if (cmd === "promote") {
  const tag = pos[0] ?? die("usage: promote <tag>");
  const rel = releases().find((r) => r.tag === tag) ?? die("no such release " + tag);
  if (!releaseExists(tag)) die(tag + " has a tag but no published release");
  moveTag(channel("stable"), rel.sha);
  if (!dry) gh("release", "edit", tag, "--prerelease=false", "--latest=" + (prefix === "kong"));
  say(tag + " is stable");
} else if (cmd === "rollback") {
  const all = releases().filter((r) => releaseExists(r.tag));
  const stableSha = refSha(channel("stable")) ?? die("no " + channel("stable") + " tag; nothing to roll back");
  const cur = all.find((r) => r.sha === stableSha) ?? die("stable does not point at a release");
  const to = opt("--to") ? all.find((r) => r.tag === opt("--to")) ?? die("no such release " + opt("--to")) : [...all.slice(0, all.indexOf(cur))].reverse().find((r) => !isPre(r.tag)) ?? die("no promoted release before " + cur.tag);
  console.log("rolling stable back " + cur.tag + " -> " + to.tag);
  if (to.sha !== cur.sha) { git("fetch", "--quiet", "origin", to.sha, cur.sha); console.log(git("log", "--format=  removed: %h %s", to.sha + ".." + cur.sha)); }
  moveTag(channel("stable"), to.sha);
  if (!dry) { gh("release", "edit", cur.tag, "--prerelease=true", "--latest=false"); gh("release", "edit", to.tag, "--prerelease=false", "--latest=" + (prefix === "kong")); }
  say("fix forward: merge the fix, then cut the next patch");
} else die("usage: release.mts plan | cut [--hotfix-from <tag>] | promote <tag> | rollback [--to <tag>]   (--dry-run, --prefix <p>)");
