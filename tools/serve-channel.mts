import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE = "usage: npx tsx tools/serve-channel.mts <stable|next> [--port N] [--dir PATH] [--no-serve]";
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const channel = argv[0];
if (channel !== "stable" && channel !== "next") { console.error(USAGE); process.exit(1); }
const port = Number(opt("--port") ?? (channel === "stable" ? 3020 : 3030));
if (!Number.isInteger(port) || port <= 0 || port > 65535) { console.error("serve-channel: --port must be a port number"); process.exit(1); }
const root = path.resolve(import.meta.dirname, "..");
const dir = path.resolve(opt("--dir") ?? path.join(os.homedir(), ".kongroyale", channel));
const win = process.platform === "win32";

const say = (m: string) => console.log("[serve-channel] " + m);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const npm = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync("npm", args, { cwd, stdio: "inherit", env, shell: win });

say(`fetching the ${channel} tag from origin`);
git(root, "fetch", "--quiet", "--force", "origin", `refs/tags/${channel}:refs/tags/${channel}`, "+refs/tags/kong-v*:refs/tags/kong-v*");
const sha = git(root, "rev-parse", `refs/tags/${channel}^{commit}`);
const label = git(root, "describe", "--tags", "--match", "kong-v*", sha);

if (!fs.existsSync(path.join(dir, ".git"))) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  say(`adding a worktree at ${dir}`);
  git(root, "worktree", "add", "--detach", dir, sha);
} else {
  if (git(dir, "status", "--porcelain")) { console.error(`serve-channel: ${dir} has local changes; it serves released code only, so clean it or pass another --dir`); process.exit(1); }
  if (git(dir, "rev-parse", "HEAD") !== sha) {
    say(`moving ${dir} to ${label} (${sha.slice(0, 7)})`);
    git(dir, "checkout", "--quiet", "--detach", sha);
  }
}

const stamp = path.join(dir, "node_modules", ".serve-channel-lock");
const lockHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "package-lock.json"))).digest("hex");
if (!fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== lockHash) {
  say("installing dependencies (npm ci)");
  npm(dir, ["ci"]);
  fs.writeFileSync(stamp, lockHash);
}

const built = path.join(dir, "dist", ".serve-channel-build");
const buildKey = `${channel} ${sha}`;
if (!fs.existsSync(built) || fs.readFileSync(built, "utf8") !== buildKey) {
  say(`building ${label} as ${channel}`);
  npm(dir, ["run", "build"], { ...process.env, KR_CHANNEL: channel });
  fs.writeFileSync(built, buildKey);
}

if (argv.includes("--no-serve")) { say(`built ${label} in ${dir}`); process.exit(0); }
say(`serving ${channel} (${label}) on http://localhost:${port}/`);
const child = spawn(process.execPath, [path.join(dir, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts", "--serve"], { cwd: dir, stdio: "inherit", env: { ...process.env, KR_PORT: String(port) } });
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => child.kill(s));
child.on("exit", (code) => process.exit(code ?? 0));
