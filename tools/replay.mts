import fs from "node:fs";
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import { Phase } from "../shared/sim/match";
import { replayMatch, type ReplayLog } from "../shared/net/replay";
import { stateHash } from "./state-hash.mts";

const argv = process.argv.slice(2), ei = argv.indexOf("--expect");
const expect = ei >= 0 ? argv[ei + 1] : undefined;
const file = argv.find((a, i) => !a.startsWith("--") && (ei < 0 || i !== ei + 1));
if (!file || (ei >= 0 && !/^[0-9a-f]{8}$/.test(expect ?? ""))) { console.error("usage: npx tsx tools/replay.mts <log.json> [--expect <8 hex digits>]"); process.exit(2); }
const log = JSON.parse(fs.readFileSync(file, "utf8")) as ReplayLog;
if (!Array.isArray(log.events) || !(log.ticks > 0)) { console.error(`${file}: not a replay log (no events array or no ticks)`); process.exit(2); }
const b = fs.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
const m = replayMatch(log, world);
const hash = stateHash(m);
console.log(`replayed ${log.events.length} events over ${m.tick} ticks (${log.opts.mode} seed ${log.opts.seed}): phase ${Phase[m.phase]}, state hash ${hash}`);
if (expect !== undefined && hash !== expect) { console.error(`REPLAY MISMATCH: state hash ${hash}, expected ${expect}`); process.exit(1); }
