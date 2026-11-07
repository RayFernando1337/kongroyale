// The admin console's report feed (server/report-feed.ts): structured fields only, a coarse browser label, the text kept
// apart until asked for, and a bounded memory. The HTTP side (session, origin, logout) is RT-14 in the admin red team.
// Run: npx tsx tools/playtest/report-feed.test.mts
import assert from "node:assert/strict";
import { family, reportFeed } from "../../server/report-feed";
import type { Bundle } from "../../server/playtest-bundles";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
assert.deepEqual(family(CHROME_WIN), { browser: "Chrome", os: "Windows" });
assert.deepEqual(family(SAFARI_MAC), { browser: "Safari", os: "macOS" });
assert.deepEqual(family(CHROME_WIN.replace("Safari/537.36", "Safari/537.36 Edg/151.0")), { browser: "Edge", os: "Windows" });
assert.deepEqual(family("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1"), { browser: "Safari", os: "iOS" });
assert.deepEqual(family(null), { browser: "Other", os: "Other" });

const diagBundle = (kind: string, chip: string | null) => ({ mark: false, timeline: null, flags: {}, replay: null, build: { channel: "next", sha: "0123456789abcdef0123456789abcdef01234567", tag: null, describe: null },
  diag: { v: 1, sid: "s", longFrames: null, events: [], path: { fields: ["t"], rows: [] }, prev: null, install: "i", kind, chip, dropped: [] } }) as unknown as Bundle;
const feed = reportFeed(), seen: number[] = [];
const stop = feed.subscribe((i) => seen.push(i.seq));
const at = new Date("2026-11-07T12:00:00Z");
const a = feed.add({ id: "KB-1", at, message: "[Stutter] it froze when I <b>landed</b>", ua: CHROME_WIN, ctx: { game: { player: { poi: { name: "MANGO MARKET" } } } }, bundle: diagBundle("report", "Stutter") });
assert.deepEqual({ ...a }, { seq: 1, at: at.toISOString(), id: "KB-1", kind: "report", chip: "Stutter", poi: "MANGO MARKET", browser: "Chrome", os: "Windows", build: "0123456", hasText: true });
assert.ok(!JSON.stringify(a).includes("froze"), "the item never carries the text");
const typed = feed.add({ id: "KB-9", at, message: "x", ua: null, ctx: { build: { sha: "abcdef0123456" }, game: { player: { poi: { name: "free words a player chose" } } } }, bundle: null });
assert.deepEqual([typed.poi, typed.build], [null, "abcdef0"], "a place that isn't on the map is dropped; a typed report's build comes from its context");
const crash = feed.add({ id: "KB-8", at, message: "Crash", ua: null, ctx: { game: { player: { poi: { name: "MANGO MARKET" } } } }, bundle: { ...diagBundle("crash", "Crashed"), diag: { ...diagBundle("crash", "Crashed").diag!, prev: { poi: "poi:peel-harbor" } as never } } });
assert.equal(crash.poi, "PEEL HARBOR", "a crash is placed where the dead session was");
const d = feed.add({ id: "KB-2", at, message: "Diagnostics from play at 7:42, Banana Temple", ua: SAFARI_MAC, ctx: null, bundle: diagBundle("diagnostics", null) });
assert.equal(d.hasText, false, "a diagnostics send has no player text to reveal");
assert.equal(feed.text(d.seq), null);
const k = feed.add({ id: "KB-3", at, message: "/kongbot the door is stuck", ua: null, ctx: "not an object", bundle: null });
assert.deepEqual([k.kind, k.poi, k.build, k.hasText], ["kongbot", null, null, true], "a chat-command report with no bundle");
assert.deepEqual(feed.text(a.seq), { id: "KB-1", text: "[Stutter] it froze when I <b>landed</b>" });
assert.deepEqual(seen, [1, 2, 3, 4, 5]);
stop();
for (let i = 0; i < 250; i++) feed.add({ id: "KB-" + (10 + i), at, message: "note " + i, ua: null, ctx: null, bundle: null });
assert.equal(seen.length, 5, "an unsubscribed listener hears nothing more");
assert.equal(feed.recent().length, 200, "the feed keeps the newest 200");
assert.equal(feed.recent()[0].seq, 56);
assert.equal(feed.text(a.seq), null, "a report's text leaves with it");
assert.deepEqual(feed.text(253), { id: "KB-257", text: "note 247" });
console.log("report feed: ok");
