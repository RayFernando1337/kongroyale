// Test for tools/playtest/ab.mts, run by npm test as the "ab" check (fast, no GPU, no network): synthetic bundles, one
// per arm plus a practice match without a link, are split by arm with the right medians and per-minute rates; timeline
// rows from before the link opened (a practice match first) don't reach the arm; deferred markers are a rate over the
// link's own play seconds, not the kept timeline's; the server's /health arms become input gaps per 1000 inputs; no
// callsign or message reaches the output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markdown, runAb, serverSide } from "./ab.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-ab-"));
const FIELDS = ["t", "fps", "p95Ms", "maxMs", "over50", "over100", "gpuMs", "pingMs", "jitterMs", "heapMB", "phase"];
/** a bundle with `before` seconds of a practice match at 500 ms ping (with lag spikes), then `playS` seconds of play at
 *  `ping` ms on its link, and the link's report (or none) */
function bundle(id: string, playS: number, ping: number, net: unknown, before = 0) {
  const rows = Array.from({ length: before + playS }, (_, i) => [i, 60, 17, 18, 0, 0, 5, i < before ? (i % 2 ? 500 : 40) : ping, 2, 300, 2]);
  const raw = { id, message: "SECRETMESSAGE", receivedAt: "2026-11-07T00:00:00Z", reporter: { name: "SECRETCALLSIGN", clientId: "install-" + id }, ctx: { game: { net } }, logs: [], bundle: { mark: true, timeline: { fields: FIELDS, rows, dropped: 0 }, flags: {}, build: null, replay: null } };
  fs.mkdirSync(path.join(tmp, id)); fs.writeFileSync(path.join(tmp, id, "bundle.json"), JSON.stringify(raw));
}
const report = (arm: string, transport: string, fallback: string | null, p50: number, p95: number, deferred: number, playS: number, since = 0) =>
  ({ transport, fallback, arm, stats: {}, ackMs: { n: 100, p50, p95, p99: p95 }, deferred, playS, since });
bundle("A1", 120, 50, report("wt", "wt", null, 40, 80, 2, 120, 90), 90);
bundle("A2", 60, 70, report("wt", "ws", "timeout", 60, 120, 4, 60));
bundle("B1", 60, 60, report("ws", "ws", "flag-off", 70, 200, 6, 60));
bundle("C1", 30, 40, report("forced-wt", "wt", null, 30, 50, 0, 30));
bundle("D1", 60, 60, report("off", "ws", "server-off", 70, 90, 10, 600));
bundle("P1", 60, -1, null);

const rows = runAb(tmp, () => assert.fail("no bundle is skipped"));
const by = new Map(rows.map((r) => [r.arm, r]));
assert.deepEqual(rows.map((r) => r.arm), ["wt", "ws", "forced-wt", "off"], "one row per arm with bundles; the practice match has no link and no row");
const wt = by.get("wt")!, ws = by.get("ws")!;
assert.equal(wt.bundles, 2); assert.equal(wt.players, 2); assert.equal(wt.onWt, 1);
assert.deepEqual(wt.fallbacks, { timeout: 1 });
assert.equal(wt.ackP50Ms, 60, "median of the bundles' p50 (the upper one of two)");
assert.equal(wt.deferredPerMin, 2, "6 deferred markers over 3 minutes of play");
assert.equal(wt.playMin, 3);
assert.equal(wt.pingMs, 70, "the practice match's 500 ms seconds before A1's link opened are not in the arm (median of 50 and 70)");
assert.equal(wt.lagSPer10Min, 0, "nor are its lag spikes");
assert.equal(by.get("off")!.deferredPerMin, 1, "10 markers over the link's 10 minutes of play, though the timeline kept only 1");
assert.deepEqual(ws.fallbacks, { "flag-off": 1 }); assert.equal(ws.ackP95Ms, 200); assert.equal(ws.deferredPerMin, 6);

const server = serverSide({ transports: { arms: {
  wt: { links: 10, settled: { wt: 8, ws: { timeout: 2, "flag-off": 0 } }, inputs: { seqs: 20000, lost: 10, recovered: 300 } },
  ws: { links: 9, settled: { wt: 0, ws: { "flag-off": 9 } }, inputs: { seqs: 18000, lost: 36, recovered: 0 } },
  off: { links: 0, settled: { wt: 0, ws: {} }, inputs: { seqs: 0, lost: 0, recovered: 0 } },
} } });
assert.deepEqual(server.map((r) => r.arm), ["wt", "ws"], "arms without links or inputs are left out");
assert.equal(server[0].lostPer1000, 0.5); assert.equal(server[0].recoveredPer1000, 15); assert.deepEqual(server[0].fallbacks, { timeout: 2 });
assert.equal(server[1].lostPer1000, 2);
assert.deepEqual(serverSide(null), [], "no /health, no server rows");

const md = markdown(rows, server);
assert.ok(md.includes("| wt | 2 | 2 | 1 | timeout 1 | 60 |"), md);
for (const secret of ["SECRETMESSAGE", "SECRETCALLSIGN", "install-"]) assert.ok(!md.includes(secret), `private text leaked: ${secret}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ab: all checks passed");
