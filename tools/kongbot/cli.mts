// KONGBOT triage CLI (reads MongoDB directly; the game server only ever writes).
//   npm run kongbot                                  = list (open reports: new, triaged, in-progress, needs-info)
//   npm run kongbot -- list [--status new|all|…] [--limit 40]
//   npm run kongbot -- show KB-12                     the readable summary (report.md) on stdout
//   npm run kongbot -- export [KB-12 …] [--status new] [--out .kongbot/inbox]
//        → <out>/KB-12/{report.md, screenshot.jpg, context.json, console.log, trail.json}
//   npm run kongbot -- set KB-12 fixed [--note "…"] [--commit <sha>] [--by <who>]
//   npm run kongbot -- note KB-12 "text" [--by <who>]
//   npm run kongbot -- stats
// statuses: new → triaged → in-progress → fixed | wontfix | duplicate | needs-info
//   KR_MONGO_URI (default mongodb://127.0.0.1:27017), KR_MONGO_DB (default kong_royale)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import type { KongbotDoc } from "../../server/kongbot";

const STATUSES = ["new", "triaged", "in-progress", "needs-info", "fixed", "wontfix", "duplicate"];
const OPEN = ["new", "triaged", "in-progress", "needs-info"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const status = flag("status"), limit = Number(flag("limit") ?? 40), out = flag("out") ?? path.join(root, ".kongbot/inbox");
const noteText = flag("note"), commit = flag("commit"), by = flag("by") ?? process.env.USER ?? "dev";
const [cmd = "list", ...rest] = argv;

const client = new MongoClient(process.env.KR_MONGO_URI || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 3000 });
try { await client.connect(); }
catch (e) { console.error(`mongo unreachable (${e instanceof Error ? e.message : e}) — start it: npm run kongbot:db`); process.exit(1); }
const col = client.db(process.env.KR_MONGO_DB || "kong_royale").collection<KongbotDoc>("kongbot_reports");

const idOf = (s: string) => { const n = Number(String(s).replace(/^kb-?/i, "")); if (!Number.isFinite(n)) { console.error(`bad id ${s}`); process.exit(2); } return n; };
const ago = (d: Date) => { const s = (Date.now() - +d) / 1000; return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const statusQuery = (s?: string) => (!s ? { status: { $in: OPEN } } : s === "all" ? {} : { status: { $in: s.split(",") } });

// ---- the summary a triager reads first
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fmt = (a: unknown) => Array.isArray(a) ? a.map((x) => (typeof x === "number" ? x.toFixed(1) : x)).join(", ") : String(a ?? "—");
function summary(r: KongbotDoc): string {
  const c = (r.ctx ?? {}) as Any, g = c.game ?? {}, p = g.player, m = g.match, perf = c.perf ?? {}, fr = perf.frames, aim = c.aim ?? {};
  const vis = aim.visual?.hits?.[0], col = aim.collision?.bullets, walk = aim.collision?.movement;
  const logs = (r.logs ?? []) as Array<{ t: number; level: string; text: string; n: number }>;
  const errs = logs.filter((l) => l.level === "error"), warns = logs.filter((l) => l.level === "warn");
  const v = c.video ?? {};
  const L: string[] = [];
  L.push(`# ${r.id} · ${r.status} · ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC (${ago(r.createdAt)} ago)`);
  L.push("", ...r.message.split("\n").map((s) => `> ${s}`), "");
  L.push(`- **Reporter:** ${r.reporter?.name ?? "?"} (client ${r.reporter?.clientId?.slice(0, 8) ?? "?"}, session ${r.reporter?.sessionId?.slice(0, 8) ?? "?"})`);
  L.push(`- **Build:** ${r.build ? `${r.build.branch}@${r.build.sha.slice(0, 9)} (+${r.build.dirtyFiles} uncommitted files) "${r.build.subject}"` : "unknown"}`);
  if (c.build) L.push(`- **Client build:** ${c.build.channel} · ${c.build.describe ?? "no kong-v tag"} · ${c.build.sha}`);
  if (p) {
    L.push(`- **Where:** ${p.poi ? `${p.poi.name} (${p.poi.inside ? "inside" : "outside"}, ${p.poi.dist} m from its centre)` : "?"} · pos ${fmt(p.pos)} · ${p.state}${p.grounded ? " grounded" : ""}${p.crouch ? " crouched" : ""}${p.swim ? " swimming" : ""}${p.slope ? " on a slope" : ""} on ${p.surface} · speed ${p.speed} m/s`);
    L.push(`- **Player:** hp ${p.hp} / shield ${p.shield} · kills ${p.kills} · holding slot ${p.active + 1} · ${(p.slots ?? []).map((s: unknown, i: number) => `${i + 1}: ${typeof s === "string" ? s : JSON.stringify(s)}`).join(" · ")}`);
  } else L.push(`- **Where:** not in a match (${c.boot?.stage ?? "?"}; camera near ${c.cameraPoi?.name ?? "?"})`);
  if (m) L.push(`- **Match:** ${m.mode}${m.range ? " (firing range)" : ""} · ${m.phase} t=${m.time}s · ${m.alive} alive · ping ${m.ping} ms · ${g.lobby?.offline ? "offline practice" : `online room ${g.lobby?.code ?? "?"}`}`);
  L.push(`- **Camera:** pos ${fmt(c.camera?.pos)} dir ${fmt(c.camera?.dir)} fov ${c.camera?.fov} (yaw ${p?.yawDeg ?? "?"}°, pitch ${p?.pitchDeg ?? "?"}°)`);
  L.push(`- **Crosshair (drawn):** ${vis ? `${vis.dist} m → ${vis.object} · ${vis.material}${vis.instanceId !== null ? ` #${vis.instanceId}` : ""}` : "sky / nothing within 600 m"}${aim.visual ? ` (${aim.visual.tested} meshes, ${aim.visual.ms} ms)` : ""}`);
  L.push(`- **Crosshair (collision):** bullets ${col ? `${col.dist} m on ${col.surf} (box ${col.box})` : "nothing"} · movement ${walk ? `${walk.dist} m on ${walk.surf}` : "nothing"}`);
  if (vis && col && Math.abs(vis.dist - col.dist) > 1.5) L.push(`  - ⚠ **visual ≠ collision:** drawn surface at ${vis.dist} m, bullets stop at ${col.dist} m`);
  else if (vis && !col && vis.dist < 150) L.push(`  - ⚠ **visual ≠ collision:** a surface is drawn at ${vis.dist} m but bullets pass through`);
  const fi = perf.frame ?? perf.renderInfo;
  L.push(`- **Perf:** ${perf.fps ?? "?"} fps · frames p50 ${fr?.p50 ?? "?"} / p99 ${fr?.p99 ?? "?"} / max ${fr?.max ?? "?"} ms, ${fr?.over50ms ?? "?"} over 50 ms (10 s) · gpu ${perf.gpuMs || "n/a"} ms · frame: ${fi?.calls ?? "?"} draws, ${fi?.triangles ?? "?"} tris · ${perf.renderInfo?.programs ?? "?"} programs, ${perf.renderInfo?.textures ?? "?"} textures · heap ${perf.heapMB?.used ?? "?"} MB`);
  L.push(`- **Device:** ${c.gpu?.renderer ?? "?"} (tier ${c.gpu?.level ?? "?"}) · ${c.env?.uaData?.platform ?? c.env?.platform ?? "?"} · ${c.env?.viewport?.w}×${c.env?.viewport?.h} @${c.env?.dpr}x, canvas ${perf.canvas?.w}×${perf.canvas?.h}, render scale ${perf.renderScale} · ${c.env?.cores} cores${c.env?.memoryGB ? `, ${c.env.memoryGB} GB` : ""}`);
  L.push(`- **Video:** preset ${v.preset ?? "?"} (auto → ${v.auto ?? "?"}) · aa ${v.aa} · ao ${v.ao} · post ${v.post} · shadows ${v.shadows} · 3D res ${v.res3d} · dynres ${v.dynres} · cap ${v.fpsCap}`);
  L.push(`- **Browser:** ${r.ua ?? c.env?.ua ?? "?"}`);
  L.push(`- **Console:** ${logs.length} entries · ${errs.length} errors · ${warns.length} warnings${c.gpu?.webgl?.glError ? ` · gl.getError() = 0x${Number(c.gpu.webgl.glError).toString(16)}` : ""}${c.gpu?.webgl?.contextLost ? " · **WebGL CONTEXT LOST**" : ""}`);
  for (const e of errs.slice(-8)) L.push(`  - \`${e.text.split("\n")[0].slice(0, 220)}\`${e.n > 1 ? ` ×${e.n}` : ""}`);
  const trail = (r.trail ?? []) as number[][];
  if (trail.length > 1) {
    // distance without teleports (spawn, plane exit, redeploy): > 15 m between two 250 ms samples
    let dist = 0; for (let i = 1; i < trail.length; i++) { const d = Math.hypot(trail[i][1] - trail[i - 1][1], trail[i][3] - trail[i - 1][3]); if (d < 15) dist += d; }
    const tail = trail.slice(-8), moved = Math.hypot(tail[tail.length - 1][1] - tail[0][1], tail[tail.length - 1][3] - tail[0][3]);
    const held = tail.filter((t) => t[7] === 1).length;
    const stuck = held >= 4 && moved < 0.75 ? ` — **STUCK: move keys held ${held}/${tail.length} samples but moved ${moved.toFixed(2)} m**` : "";
    L.push(`- **Trail:** ${trail.length} samples over ${(trail[trail.length - 1][0] - trail[0][0]).toFixed(0)} s, ${dist.toFixed(0)} m walked · last 2 s before the report: moved ${moved.toFixed(1)} m, move keys held ${held}/${tail.length}${stuck} · y ${Math.min(...trail.map((t) => t[2])).toFixed(1)}…${Math.max(...trail.map((t) => t[2])).toFixed(1)}`);
  }
  const q = c.page?.query ?? {};
  const gpuArg = c.gpu?.renderer ? `&gpu=${encodeURIComponent(c.gpu.renderer)}` : "";
  const qArg = v.post ? `&q=${v.post === "epic" ? "ultra" : v.post}` : "";
  L.push("", "## Repro");
  if (c.camera?.cam) {
    L.push(`- Their exact view (view camera, full world): \`http://localhost:5317/?cam=${c.camera.cam}${qArg}\``);
    L.push(`- Render it headless: \`node tools/shot.mjs --cam ${c.camera.cam} --q ${v.post === "epic" ? "ultra" : v.post ?? "high"} --out .kongbot/inbox/${r.id}/repro\``);
  }
  if (gpuArg) L.push(`- Their video tier on first visit: open the game with \`?${gpuArg.slice(1)}\` in a fresh profile (the preset comes from the GPU string)`);
  if (Object.keys(q).length) L.push(`- Their URL flags: \`${new URLSearchParams(q as Record<string, string>).toString()}\``);
  if (r.notes?.length) { L.push("", "## Notes"); for (const n of r.notes) L.push(`- ${n.at.toISOString().slice(0, 16)} ${n.by}: ${n.text}`); }
  if (r.history?.length > 1) { L.push("", "## History"); for (const h of r.history) L.push(`- ${h.at.toISOString().slice(0, 16)} ${h.by} → ${h.status}${h.note ? `: ${h.note}` : ""}`); }
  L.push("", "Files: screenshot.jpg (what they saw, no HUD) · context.json (everything) · console.log · trail.json ([t s, x, y, z, yaw°, state, hp+shield, move keys held] at 4 Hz, up to the moment the bar opened; state 0 ground 1 freefall 2 glide 3 dead 4 plane 5 spectate 6 zip)");
  return L.join("\n");
}

function exportOne(r: KongbotDoc) {
  const dir = path.join(out, r.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), summary(r) + "\n");
  const { shot, logs, trail, ...rest } = r;
  fs.writeFileSync(path.join(dir, "context.json"), JSON.stringify(rest, null, 1));
  fs.writeFileSync(path.join(dir, "trail.json"), JSON.stringify(trail ?? []));
  fs.writeFileSync(path.join(dir, "console.log"), ((logs ?? []) as Array<{ t: number; level: string; text: string; n: number }>).map((l) => `${(l.t / 1000).toFixed(2).padStart(8)}s ${l.level.toUpperCase().padEnd(5)} ${l.text}${l.n > 1 ? `  (×${l.n})` : ""}`).join("\n") + "\n");
  if (shot) fs.writeFileSync(path.join(dir, r.shotMime === "image/png" ? "screenshot.png" : "screenshot.jpg"), Buffer.from(shot.buffer));
  return dir;
}

async function one(id: string) {
  const r = await col.findOne({ num: idOf(id) });
  if (!r) { console.error(`${id}: no such report`); process.exit(3); }
  return r;
}

switch (cmd) {
  case "list": {
    const rows = await col.find(statusQuery(status), { projection: { shot: 0, logs: 0, trail: 0 } }).sort({ num: -1 }).limit(limit).toArray();
    if (!rows.length) { console.log(`no ${status ?? "open"} reports`); break; }
    for (const r of rows) {
      const c = (r.ctx ?? {}) as Any, where = c.game?.player?.poi?.name ?? (c.game?.inMatch ? "?" : "title");
      console.log(`${r.id.padEnd(7)} ${r.status.padEnd(11)} ${ago(r.createdAt).padStart(4)}  ${(r.reporter?.name ?? "?").padEnd(14)} ${String(where).padEnd(15)} ${r.message.replace(/\s+/g, " ").slice(0, 90)}`);
    }
    break;
  }
  case "show": { for (const id of rest) console.log(summary(await one(id)) + "\n"); break; }
  case "export": {
    const docs = rest.length ? await Promise.all(rest.map(one)) : await col.find(statusQuery(status ?? "new")).sort({ num: 1 }).limit(limit).toArray();
    for (const r of docs) console.log(exportOne(r));
    if (!docs.length) console.log(`no ${status ?? "new"} reports`);
    break;
  }
  case "set": {
    const [id, st] = rest;
    if (!STATUSES.includes(st)) { console.error(`status must be one of ${STATUSES.join(", ")}`); process.exit(2); }
    const at = new Date();
    const r = await col.findOneAndUpdate({ num: idOf(id) }, { $set: { status: st, ...(commit ? { fixedIn: commit } : {}) }, $push: { history: { at, by, status: st, ...(noteText || commit ? { note: [noteText, commit && `commit ${commit}`].filter(Boolean).join(" · ") } : {}) }, ...(noteText ? { notes: { at, by, text: noteText } } : {}) } as Any }, { returnDocument: "after", projection: { id: 1, status: 1 } });
    console.log(r ? `${r.id} → ${r.status}` : `${id}: no such report`);
    break;
  }
  case "note": {
    const [id, ...words] = rest;
    const text = words.join(" ").trim();
    if (!text) { console.error("note text required"); process.exit(2); }
    const r = await col.findOneAndUpdate({ num: idOf(id) }, { $push: { notes: { at: new Date(), by, text } } }, { returnDocument: "after", projection: { id: 1 } });
    console.log(r ? `${r.id}: noted` : `${id}: no such report`);
    break;
  }
  case "stats": {
    const by = await col.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    const pois = await col.aggregate<{ _id: string; n: number }>([{ $match: { status: { $in: OPEN } } }, { $group: { _id: "$ctx.game.player.poi.name", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    console.log("by status:", by.map((b) => `${b._id} ${b.n}`).join(" · ") || "none");
    console.log("open by POI:", pois.map((b) => `${b._id ?? "title/none"} ${b.n}`).join(" · ") || "none");
    break;
  }
  default: console.error(`unknown command ${cmd} — list | show | export | set | note | stats`); process.exitCode = 2;
}
await client.close();
