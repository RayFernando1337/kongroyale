// Measures game balance from headless all-bot matches: match length, the survival curve, deaths and eliminations by
// cause (storm, fall, each weapon), and damage, kills and time-to-kill per weapon, over N seeds per mode and bot
// difficulty. Measuring only: it reads shared/sim/const.ts and changes nothing.
//   npx tsx tools/balance.mts                                   (seeds 1-5, trios, standard)
//   npx tsx tools/balance.mts --seeds 1-10 --modes solo,trios --difficulty easy,standard,hard --out balance.json
// --seeds takes single seeds and ranges: 42, 1-10, 3,7,42. Each match runs to RESULTS or --max-ticks (default 20 min).
// The output is deterministic: the same seeds give the same numbers and the same JSON on every run on this Node, so two
// checkouts can be diffed. Wall time goes to stderr only. About 20 s per match on a 4-vCPU runner.
// Per weapon: damage is every EV.Hit, credited to the shooter's held weapon on that tick (a rocket that lands after
// its shooter switched weapons is credited to the new one). Time-to-kill runs from the killer's first hit on the
// victim to the death, so a victim someone else had already hurt dies faster; a gap of more than TTK_GAP_S between
// hits starts a new engagement. A death is respawnable while
// RESURGENCE is on (EV.Kill final = 0) and an elimination after it.
import fs from "node:fs";
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import { Match, Phase } from "../shared/sim/match";
import { alive, SK } from "../shared/sim/player";
import { Reader, EV, EV_BYTES } from "../shared/net/proto";
import { WEAPONS } from "../shared/world/map";
import type { BotDifficulty } from "../shared/sim/const";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const seeds = opt("--seeds", "1-5").split(",").flatMap((s) => { const [a, b] = s.split("-").map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i); });
const modes = opt("--modes", "trios").split(",") as Array<"solo" | "trios">;
const difficulties = opt("--difficulty", "standard").split(",") as BotDifficulty[];
const maxTicks = Number(opt("--max-ticks", String(60 * 60 * 20))), out = opt("--out", "");
for (const m of modes) if (m !== "solo" && m !== "trios") throw Error(`--modes takes solo,trios, not ${m}`);
for (const d of difficulties) if (!["easy", "standard", "hard"].includes(d)) throw Error(`--difficulty takes easy,standard,hard, not ${d}`);
if (!seeds.length || seeds.some((s) => !Number.isInteger(s))) throw Error("--seeds takes seeds and ranges, e.g. 42 or 1-10 or 3,7,42");

const TTK_GAP_S = 10, CURVE_STEP_S = 30;
const b = fs.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
const cause = (w: number) => w === 255 ? "storm" : w === 254 ? "fall" : WEAPONS[w] ?? `code${w}`;

interface WeaponStats { damage: number; hits: number; respawns: number; eliminations: number; ttkS: number[] }
interface MatchResult {
  seed: number; mode: string; difficulty: string; finished: boolean; winnerTeam: number;
  /** seconds from the first PLAY tick to RESULTS (or to --max-ticks) */
  playS: number;
  /** players alive every CURVE_STEP_S seconds of PLAY, starting at 0 */
  aliveCurve: number[];
  respawnsByCause: Record<string, number>; eliminationsByCause: Record<string, number>;
  weapons: Record<string, WeaponStats>;
}

function play(seed: number, mode: "solo" | "trios", difficulty: BotDifficulty): MatchResult {
  const m = new Match({ seed, mode, world, humans: [], botDifficulty: difficulty });
  m.startNow();
  const n = m.players.length, firstHit = new Float64Array(n * n).fill(-1), lastHit = new Float64Array(n * n).fill(-1);
  const r: MatchResult = { seed, mode, difficulty, finished: false, winnerTeam: -1, playS: 0, aliveCurve: [], respawnsByCause: {}, eliminationsByCause: {}, weapons: {} };
  const ws = (name: string) => (r.weapons[name] ??= { damage: 0, hits: 0, respawns: 0, eliminations: 0, ttkS: [] });
  let playStart = -1;
  for (let i = 0; i < maxTicks && m.phase !== Phase.Results; i++) {
    m.step();
    if (m.phase === Phase.Play && playStart < 0) playStart = m.time;
    if (playStart >= 0 && m.phase === Phase.Play && m.time - playStart >= r.aliveCurve.length * CURVE_STEP_S) r.aliveCurve.push(m.players.filter(alive).length);
    if (m.ev.empty) continue;
    const rd = new Reader(m.ev.finish(m.tick)); rd.u8(); const count = rd.u8(); rd.u32();
    for (let e = 0; e < count; e++) {
      const k = rd.u8(), start = rd.o;
      if (k === EV.Hit) {
        const a = rd.u8(), v = rd.u8(); rd.u8(); const dmg = rd.u16() / 4, s = m.players[a];
        if (s && a !== v) {
          const slot = s.slots[s.active];
          if (slot.kind === SK.Weapon) { const w = ws(WEAPONS[slot.id]); w.damage += dmg; w.hits++; }
          const j = a * n + v;
          if (firstHit[j] < 0 || m.time - lastHit[j] > TTK_GAP_S) firstHit[j] = m.time;
          lastHit[j] = m.time;
        }
      } else if (k === EV.Kill) {
        const killer = rd.u8(), v = rd.u8(), w = rd.u8(), final = rd.u8() === 1, c = cause(w);
        const by = final ? r.eliminationsByCause : r.respawnsByCause; by[c] = (by[c] ?? 0) + 1;
        if (w < WEAPONS.length) {
          const st = ws(c); if (final) st.eliminations++; else st.respawns++;
          const j = killer * n + v;
          if (killer < n && firstHit[j] >= 0) st.ttkS.push(m.time - firstHit[j]);
          if (killer < n) firstHit[j] = -1;
        }
      }
      const len = EV_BYTES[k]; if (len === undefined) break; rd.o = start + len;
    }
    m.ev.reset();
  }
  r.finished = m.phase === Phase.Results; r.winnerTeam = m.winnerTeam; r.playS = playStart < 0 ? 0 : m.time - playStart;
  return r;
}

const median = (v: number[]) => { if (!v.length) return NaN; const a = [...v].sort((x, y) => x - y), h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };
const results: MatchResult[] = [];
for (const mode of modes) for (const difficulty of difficulties) for (const seed of seeds) {
  const t = performance.now();
  results.push(play(seed, mode, difficulty));
  const r = results[results.length - 1];
  process.stderr.write(`${mode} ${difficulty} seed ${seed}: ${r.finished ? "finished" : "cut off"} after ${r.playS.toFixed(0)} s of play (${((performance.now() - t) / 1000).toFixed(1)} s wall)\n`);
}

const f1 = (v: number) => Number.isNaN(v) ? "—" : v.toFixed(1);
for (const mode of modes) for (const difficulty of difficulties) {
  const rs = results.filter((r) => r.mode === mode && r.difficulty === difficulty);
  console.log(`\n## ${mode}, ${difficulty}: ${rs.length} seeds (${seeds.join(", ")}), ${rs.filter((r) => r.finished).length} finished\n`);
  console.log(`match length (s of PLAY): median ${f1(median(rs.map((r) => r.playS)))}, range ${f1(Math.min(...rs.map((r) => r.playS)))}–${f1(Math.max(...rs.map((r) => r.playS)))}`);
  const steps = Math.max(...rs.map((r) => r.aliveCurve.length));
  const curve = Array.from({ length: steps }, (_, i) => median(rs.map((r) => r.aliveCurve[i] ?? 0)));
  console.log(`alive every ${CURVE_STEP_S} s (median over seeds; a finished match counts 0): ${curve.map((v) => f1(v)).join(" ")}`);
  const causes = [...new Set(rs.flatMap((r) => [...Object.keys(r.respawnsByCause), ...Object.keys(r.eliminationsByCause)]))].sort();
  console.log("\n| cause | respawnable deaths / match | eliminations / match |\n|---|---|---|");
  for (const c of causes) console.log(`| ${c} | ${f1(median(rs.map((r) => r.respawnsByCause[c] ?? 0)))} | ${f1(median(rs.map((r) => r.eliminationsByCause[c] ?? 0)))} |`);
  console.log("\n| weapon | damage / match | hits / match | damage / hit | deaths / match | TTK median s | TTK p90 s | TTK samples |\n|---|---|---|---|---|---|---|---|");
  for (const w of WEAPONS) {
    const per = rs.map((r) => r.weapons[w] ?? { damage: 0, hits: 0, respawns: 0, eliminations: 0, ttkS: [] }), ttk = per.flatMap((p) => p.ttkS).sort((a, b) => a - b);
    const dmg = per.reduce((s, p) => s + p.damage, 0), hits = per.reduce((s, p) => s + p.hits, 0);
    console.log(`| ${w} | ${f1(median(per.map((p) => p.damage)))} | ${f1(median(per.map((p) => p.hits)))} | ${f1(hits ? dmg / hits : NaN)} | ${f1(median(per.map((p) => p.respawns + p.eliminations)))} | ${f1(median(ttk))} | ${f1(ttk.length ? ttk[Math.min(ttk.length - 1, Math.ceil(ttk.length * 0.9) - 1)] : NaN)} | ${ttk.length} |`);
  }
}
if (out) fs.writeFileSync(out, JSON.stringify({ tool: "balance", seeds, modes, difficulties, maxTicks, ttkGapS: TTK_GAP_S, curveStepS: CURVE_STEP_S, results }, null, 2) + "\n");
