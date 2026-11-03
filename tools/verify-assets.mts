#!/usr/bin/env node
// Asset source check: every file under public/assets/ must have a recorded source or licence, or this exits 1.
// Not wired into `npm test` or CI; run it by hand:  node --import tsx tools/verify-assets.mts [--json] [--all]
//
// A file counts as attributed when any of these covers it, checked in this order:
//   1. credits  - a path or glob in backticks in CREDITS.md that starts with public/assets/ ("*" = within a folder,
//                 "**" = any depth; a path ending in "/" covers the whole folder).
//   2. sidecar  - a provenance file in the file's folder or a parent folder under public/assets/. LICENSE, NOTICE and
//                 provenance.json cover the folder tree. SOURCES.json and tex.json cover only files whose name
//                 starts with a top-level key whose own entry has a source and a licence (e.g. "wall" covers wall-d.webp).
//                 A sidecar with a string "note" and a "layers" array (terrain/tex3) covers every file under a folder named
//                 by a layer.
//                 Licence texts are covered by being one.
//   3. manifest - tools/asset-sources.json, if present (optional, proposed format below).
// *.json files are project data (indexes, metadata) rather than art, so they are skipped unless --all is given.
//
// Manifest format (tools/asset-sources.json): an array of entries. Any matching entry counts.
//   [
//     { "path": "public/assets/audio/kr/step/", "source": "Freesound CC0 packs", "licence": "CC0" },
//     { "path": "public/assets/terrain/tex3/", "source": "original", "licence": "MIT (AI-generated, see CREDITS.md)" }
//   ]
// "path" is a repo-relative file, folder (trailing "/") or glob. "source" and "licence" must both be non-empty.
// Entries that match no file are reported as stale and fail the run.
//
// Output: attributed count per rule, then every unattributed file grouped by folder. --json prints machine output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = "public/assets/";
const SIDECARS = new Set(["LICENSE", "NOTICE", "provenance.json", "SOURCES.json", "tex.json"]);
const asJson = process.argv.includes("--json");
const all = process.argv.includes("--all");

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

function globToRegExp(g: string): RegExp {
  const body = g.endsWith("/") ? g + "**" : g;
  const re = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\u0001/g, "(?:.*/)?");
  return new RegExp("^" + re + "$");
}

type Rule = { kind: "credits" | "manifest"; path: string; re: RegExp; note: string; hits: number };
const rules: Rule[] = [];

const credits = fs.readFileSync(path.join(root, "CREDITS.md"), "utf8");
for (const m of credits.matchAll(/`(public\/assets\/[^`]+)`/g)) {
  rules.push({ kind: "credits", path: m[1], re: globToRegExp(m[1]), note: "CREDITS.md", hits: 0 });
}

const manifestPath = path.join(root, "tools/asset-sources.json");
const problems: string[] = [];
if (fs.existsSync(manifestPath)) {
  const entries = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const e of entries) {
    if (!e.path?.startsWith(ASSETS) || !e.source || !e.licence) {
      problems.push("bad manifest entry: " + JSON.stringify(e));
      continue;
    }
    rules.push({ kind: "manifest", path: e.path, re: globToRegExp(e.path), note: e.source + " / " + e.licence, hits: 0 });
  }
}

const files = walk(path.join(root, ASSETS), []);
const sidecarDirs = new Set<string>();
const keyedSidecars = new Map<string, string[]>();
for (const f of files) {
  const name = path.posix.basename(f);
  if (!SIDECARS.has(name)) continue;
  const dir = path.posix.dirname(f);
  if (name !== "SOURCES.json" && name !== "tex.json") {
    sidecarDirs.add(dir);
    continue;
  }
  const entries = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
  const documented = (e: any) => typeof e?.source === "string" && e.source !== "" && (e.license || e.licence);
  const keys = Object.keys(entries).filter((k) => documented(entries[k]));
  if (typeof entries.note === "string" && entries.note !== "" && Array.isArray(entries.layers)) keys.push(...entries.layers);
  keyedSidecars.set(dir, keys);
}
const isLicenceText = (f: string) => /(^|\/)(LICENSE|NOTICE)$|-OFL\.txt$/.test(f);

const unattributed: string[] = [];
const counts = new Map<string, number>();
let skipped = 0;
for (const f of files) {
  if (!all && f.endsWith(".json")) {
    skipped++;
    continue;
  }
  let how: string | undefined;
  const matched = rules.filter((r) => r.re.test(f));
  for (const r of matched) r.hits++;
  if (matched.length) how = matched[0].kind + ": " + matched[0].path; else if (isLicenceText(f) || SIDECARS.has(path.posix.basename(f))) how = "licence text or sidecar";
  else {
    for (let d = path.posix.dirname(f); d.length >= ASSETS.length - 1 && !how; d = path.posix.dirname(d)) {
      if (sidecarDirs.has(d)) how = "sidecar: " + d + "/";
      const keys = keyedSidecars.get(d);
      if (!how && keys?.some((k) => f.slice(d.length + 1).split("/").some((s, i, a) => (i === a.length - 1 ? s.startsWith(k) : s === k)))) how = "sidecar keys: " + d + "/";
    }
  }
  if (!how) unattributed.push(f);
  else counts.set(how, (counts.get(how) ?? 0) + 1);
}

const stale = rules.filter((r) => r.hits === 0).map((r) => r.kind + " rule matches no file: " + r.path);
const byDir = new Map<string, string[]>();
for (const f of unattributed) {
  const d = path.posix.dirname(f);
  byDir.set(d, [...(byDir.get(d) ?? []), f]);
}
const ok = unattributed.length === 0 && problems.length === 0 && stale.filter((s) => s.startsWith("manifest")).length === 0;

if (asJson) {
  console.log(JSON.stringify({ files: files.length, skipped, attributed: Object.fromEntries(counts), unattributed, stale, problems }, null, 2));
} else {
  console.log(`${files.length} files under ${ASSETS} (${skipped} .json data files skipped)`);
  console.log("\nAttributed by:");
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log(`\nUnattributed: ${unattributed.length} files in ${byDir.size} folders`);
  for (const [d, fs_] of [...byDir].sort()) console.log(`  ${String(fs_.length).padStart(5)}  ${d}/  e.g. ${path.posix.basename(fs_[0])}`);
  for (const s of [...stale, ...problems]) console.log("note: " + s);
  console.log(ok ? "\nOK: every asset has a source." : "\nFAIL: add credits (CREDITS.md) or manifest entries for the folders above.");
}
process.exit(ok ? 0 : 1);
