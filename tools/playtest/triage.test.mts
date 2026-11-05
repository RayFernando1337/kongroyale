// Test for tools/playtest/triage.mts and the cli.mts watch ticker, run by npm test as the "triage" check (fast, no GPU, no
// network). The bundles in tools/playtest/fixtures/ are hand-written and tiny: a Safari crash, three Chrome stalls from two
// installs (one install reported twice), a lag report, a memory-growth report, an uncaught error and a truncated bundle.json.
// Every callsign and message in them is a made-up token, so the test can prove none of them reaches a public output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanBundle } from "./analysis.mts";
import { browserOf, buildClusters, runTriage, stripVolatile, tickerLine, triageBundle } from "./triage.mts";
import type { IndexEntry } from "./triage.mts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-triage-"));
const callsigns = ["ZORBLAX", "PIXELPETE", "SAFARIKONG", "LAGGYLARRY", "LEAKYLEO", "ERRORERIC"];
const words = ["froze for a second", "rubber banding", "F8 mark in match", "black screen", "tab died", "gets slower", "happened again"];
const clean = (s: string) => { for (const w of [...callsigns, ...words]) assert.ok(!s.includes(w), `private text leaked: ${w}`); };

{
  const warnings: string[] = [];
  const out = path.join(tmp, "out");
  const r = runTriage(FIXTURES, out, (m) => warnings.push(m));
  const by = new Map(r.entries.map((e) => [e.id, e]));

  assert.equal(r.entries.length, 7);
  assert.equal(r.skipped, 1);
  assert.equal(warnings.length, 1, "the truncated bundle.json is skipped with one warning");
  assert.ok(warnings[0].includes("KB-BAD1"));

  const saf = by.get("KB-SAF1")!;
  assert.equal(saf.kind, "crash");
  assert.deepEqual(saf.symptoms, ["crash"]);
  assert.equal(saf.severity, 10);
  assert.equal(saf.config.browser.family, "Safari");
  assert.equal(saf.config.browser.major, 17);
  assert.equal(saf.config.os, "macOS");
  assert.equal(saf.config.gpuVendor, "apple");
  assert.equal(saf.location.phase, "play", "a crash is placed where the dead session was");
  assert.equal(saf.location.poi, "banana-temple");
  assert.equal(saf.fingerprint, "crash|play|banana-temple|-|Safari|high");

  const c1 = by.get("KB-CHR1")!;
  assert.equal(c1.kind, "report");
  assert.deepEqual(c1.symptoms, ["stall"]);
  assert.equal(c1.severity, 5, "a stall over 500 ms weighs 5");
  assert.deepEqual(c1.worstStall, { t: 6, maxMs: 640, phase: "play" });
  assert.equal(c1.attribution, "invoker fn@main-AbC123xy.js:1234 640 ms");
  assert.equal(c1.location.cell, "2,-2", "the grid cell comes from the path row at the stall");
  assert.deepEqual(c1.config.nonDefaultFlags, ["shadows=off"], "perfhud and seed are not config");
  assert.deepEqual(c1.fps, { p50: 60, p5: 14 });
  assert.equal(c1.heapPeakMB, 300);
  assert.match(c1.installHash!, /^[0-9a-f]{12}$/);
  assert.ok(!c1.installHash!.includes("chrome"), "the install id is hashed");

  const c2 = by.get("KB-CHR2")!, c3 = by.get("KB-CHR3")!;
  assert.equal(c2.kind, "mark");
  assert.equal(c2.attribution, "invoker fn@main-ZzZ999aa.js:77 710 ms", "the biggest loaf/longtask within 1 s wins");
  assert.equal(c1.fingerprint, c2.fingerprint, "line numbers, counts and file hashes don't split a fingerprint");
  assert.equal(c1.fingerprint, c3.fingerprint);
  assert.equal(c1.fingerprint, "stall|play|banana-temple|invoker fn@main.js ms|Chrome|high");
  assert.equal(c1.installHash, c3.installHash, "one install reporting twice");
  assert.notEqual(c1.installHash, c2.installHash);

  assert.deepEqual(by.get("KB-LAG1")!.symptoms, ["lag"]);
  assert.deepEqual(by.get("KB-MEM1")!.symptoms, ["memory"]);
  assert.equal(by.get("KB-MEM1")!.config.browser.family, "Edge");
  const err = by.get("KB-ERR1")!;
  assert.deepEqual(err.symptoms, ["error"]);
  assert.equal(err.errorKey, "[uncaught] TypeError: Cannot read properties of undefined (reading 'x')");
  assert.ok(err.fingerprint.includes(err.errorKey!), "an error report is told apart by its message");
  for (const e of r.entries) assert.deepEqual(e.symptoms.length > 0, true);

  const cl = r.clusters;
  assert.equal(cl.length, 5);
  assert.deepEqual(cl.map((c) => c.symptom), ["stall", "crash", "lag", "error", "memory"], "ranked by players x severity x recency");
  assert.deepEqual(cl.map((c) => c.score), [10, 5, 3, 2, 1.5]);
  assert.deepEqual(cl.map((c) => c.recency), [1, 0.5, 1, 1, 0.5], "a cluster a day or more behind the newest report halves");
  const stall = cl[0];
  assert.equal(stall.count, 3);
  assert.equal(stall.distinctInstalls, 2, "two installs, one of them twice");
  assert.deepEqual(stall.builds, ["next@b9840d6"]);
  assert.equal(stall.configs.length, 2);
  assert.equal(stall.title, "Stall in play at banana-temple: Chrome, high tier (2 players)");
  assert.equal(stall.representatives.length, 3);
  assert.deepEqual(stall.notes.map((n) => n.id).sort(), ["KB-CHR1", "KB-CHR3"], "marks carry no player note");
  assert.ok(stall.notes.every((n) => n.text.includes("note-token")));

  const md = fs.readFileSync(path.join(out, "clusters.md"), "utf8");
  assert.ok(md.indexOf("Stall in play") < md.indexOf("Crash in play") && md.indexOf("Crash in play") < md.indexOf("Memory growth"));
  clean(md);
  clean(fs.readFileSync(path.join(out, "index.jsonl"), "utf8"));
  const json = fs.readFileSync(path.join(out, "clusters.json"), "utf8");
  for (const c of callsigns) assert.ok(!json.includes(c), `callsign in clusters.json: ${c}`);
  assert.ok(json.includes("it happened again"), "notes are kept for the issue-filing step");

  const files = ["index.jsonl", "clusters.json", "clusters.md"];
  const first = files.map((f) => [fs.readFileSync(path.join(out, f), "utf8"), fs.statSync(path.join(out, f)).mtimeMs] as const);
  runTriage(FIXTURES, out, () => {});
  files.forEach((f, i) => {
    assert.equal(fs.readFileSync(path.join(out, f), "utf8"), first[i][0], `${f} changed on a rerun`);
    assert.equal(fs.statSync(path.join(out, f)).mtimeMs, first[i][1], `${f} was rewritten on a rerun`);
  });
  assert.equal(fs.readFileSync(path.join(out, "index.jsonl"), "utf8").trim().split("\n").length, 7);

  const now = Date.parse("2026-11-05T18:25:00Z");
  const line = tickerLine(r.entries, now);
  assert.equal(line, "5 reports this hour · top: Stall at banana-temple, Chrome (2) · latest: Stall, Chrome, Windows");
  assert.equal(tickerLine(r.entries, now + 86_400_000), "0 reports this hour");
  clean(line);
}

{
  assert.equal(stripVolatile("invoker fn@index-DX9s8aKf.js:123 45 ms"), "invoker fn@index.js ms");
  assert.equal(stripVolatile("shader programs +12"), "shader programs");
  assert.equal(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1").family, "Chrome");
  assert.equal(browserOf("curl/8").family, "other");
}

{
  const hostile: unknown[] = [
    { id: 5, message: { a: 1 }, receivedAt: 7, ctx: "string", logs: "nope", bundle: { timeline: "x", flags: [1], build: 4 } },
    { id: "KB-H2", message: "x".repeat(5000), receivedAt: "not a date", bundle: { mark: "yes", timeline: { fields: ["t", "fps", "phase"], rows: [[1, 60], "row", [2, "x", 2], [3, 20, 2]], dropped: "many" } },
      ctx: { env: { ua: 7, dpr: "big", memoryGB: {} }, gpu: [], diag: { events: [null, [1], ["x", 1], [1, "loaf", "slow", 5]], path: { fields: "t", rows: [[]] }, prev: [] }, perf: { heapMB: { limit: "huge" } }, game: { player: { pos: "here", poi: [] } } },
      logs: [null, { level: "error", text: 9 }, { level: "error", text: "[uncaught] boom 42\n at x" }] },
  ];
  for (const h of hostile) {
    const s = cleanBundle(h);
    if (!s) continue;
    const { entry } = triageBundle(s);
    assert.ok(entry.symptoms.length > 0 && Number.isFinite(entry.severity));
    assert.ok(entry.fingerprint.length < 300);
  }
  assert.equal(cleanBundle("string"), null);
  assert.equal(cleanBundle({ id: "x" }), null);
  const e = triageBundle(cleanBundle(hostile[1])!).entry;
  assert.equal(e.errorKey, "[uncaught] boom", "a number in an error doesn't split its cluster");
  const entries: IndexEntry[] = [];
  assert.deepEqual(buildClusters(entries), []);
}

{
  const dir = path.join(tmp, "watch");
  fs.cpSync(FIXTURES, dir, { recursive: true });
  const ticker = path.join(dir, "ticker.txt");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "cli.mts"), "watch", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", () => {});
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(ok(), `watch did not ${what}\n${stdout}`);
  };
  try {
    await until(() => fs.existsSync(ticker), "write the ticker");
    assert.equal(fs.readFileSync(ticker, "utf8").trim(), "0 reports this hour", "the fixtures are old news");
    const live = JSON.parse(fs.readFileSync(path.join(FIXTURES, "2026-11-05T18-00-00Z-KB-CHR1", "bundle.json"), "utf8"));
    live.id = "KB-LIVE1"; live.receivedAt = new Date().toISOString();
    fs.mkdirSync(path.join(dir, "9999-KB-LIVE1"));
    fs.writeFileSync(path.join(dir, "9999-KB-LIVE1", "bundle.json"), JSON.stringify(live));
    await until(() => stdout.includes("KB-LIVE1"), "print the new bundle");
    await until(() => fs.readFileSync(ticker, "utf8").startsWith("1 report this hour"), "update the ticker");
    const mine = stdout.split("\n").filter((l) => l.includes("KB-LIVE1"));
    assert.equal(mine.length, 1, "one line per bundle");
    assert.match(mine[0], /stall .*Chrome 131 · Windows · nvidia · high  banana-temple  KB-LIVE1$/);
    clean(stdout);
    clean(fs.readFileSync(ticker, "utf8"));
  } finally { child.kill(); }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("playtest triage: ok");
