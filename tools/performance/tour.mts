// The play route gpu-match.mts drives with --route tour: walks through the densest towns, a close fight with bots, a
// tuk-tuk drive across the island and a helicopter flight, each one segment that becomes one measured case. The same
// state machine (tourRunner) runs in the page, once per frame on the player's controls, and in Node, once per tick on
// a headless Match (tour-check.mts), so a route that gets stuck on a wall fails there in seconds, not on a GPU job.
//
// Between segments the player is teleported on the practice match's in-page host (an offline practice match only:
// gpu-match never touches a server it didn't start), and the first settleS seconds after a teleport are not measured:
// a teleport is not something a player does, and the streaming and pop-in it causes would swamp the segment. The
// player is healed on the host so bots and the storm can't end the route early. Everything else is the real game: the
// player's inputs go through GameInput and the client's prediction, and the bots play their own match.
//
// tourRunner and steer must stay self-contained (no imports, no module-scope references): gpu-match ships their
// source into the page with Function.toString().

/** what a segment does once the player is in place */
export type SegKind = "walk" | "drive" | "fly" | "fight" | "look";
export type XZ = readonly [number, number];
export interface Segment {
  /** case id: gpu/tour/<id> */
  id: string;
  kind: SegKind;
  /** the case's definition (what the frames in it show) */
  what: string;
  /** where the player is put (x, z, metres) and facing (yaw, rad); drive / fly: the vehicle nearest here is boarded */
  at: XZ; yaw: number;
  /** waypoints, in order (walk, drive, fly) */
  path: XZ[];
  /** the measured part ends after this many seconds, or at the last waypoint, whichever is first */
  seconds: number;
  /** unmeasured seconds after the teleport (and after boarding) */
  settleS: number;
  /** fight: this many enemy bots brought to a ring ring[0]..ring[1] m around the player */
  bots?: number; ring?: XZ;
  /** look: yaw rate (rad/s) of the pan; with frames set, a fixed step per frame instead (a survey on a software GPU) */
  rate?: number; frames?: number;
  /** fly: cruise height above the ground (m) */
  cruise?: number;
}

export const TOUR_VERSION = 1;

export const TOUR: Segment[] = [
  { id: "walk-town", kind: "walk", what: "sprinting through Mango Market: up Banana Avenue, across Banana Square, round Back Street to the Market Plaza, down Market Street",
    at: [360, 129], yaw: -2.4, seconds: 75, settleS: 3,
    path: [[390, 100], [402, 73], [414, 49], [416, 43], [418, 39], [418, 35], [420, 33], [422, -6], [439, -2], [443, 2], [447, 2], [467, -24], [469, -28], [478, -46], [470, -54], [466, -58], [466, -62], [460, -70], [460, -64], [458, -62], [452, -64], [450, -68], [442, -74], [422, -84], [392, -90], [388, -92], [368, -100]] },
  { id: "fight", kind: "fight", what: "a close fight in Banana Square: the six nearest enemy bots brought to 10-20 m, the player firing an AR at the nearest",
    at: [410, 30], yaw: 0, seconds: 25, settleS: 2, bots: 6, ring: [10, 20], path: [] },
  { id: "tuk-drive", kind: "drive", what: "a tuk-tuk from the Plantation's packing house east across the island, over the ridge and up Banana Avenue into Mango Market",
    at: [-238, 236], yaw: 0, seconds: 150, settleS: 2,
    path: [[-232,218],[-230,174],[-200,144],[-170,112],[-162,96],[-144,76],[-140,68],[-136,56],[-128,40],[-122,34],[-110,22],[-102,24],[-92,66],[-88,92],[-72,128],[-56,162],[-52,168],[-40,184],[-20,188],[-8,198],[-4,202],[26,232],[54,209],[54,177],[54,147],[44,117],[44,105],[48,75],[50,61],[52,53],[48,37],[56,-7],[56,-51],[56,-67],[76,-101],[108,-95],[140,-71],[174,-59],[202,-49],[244,-37],[272,-37],[290,-33],[292,-25],[290,-19],[292,-9],[292,9],[290,13],[292,55],[308,83],[310,93],[316,101],[330,115],[332,119],[340,127],[368,123],[374,117],[402,83],[408,75],[410,67]] },
  { id: "heli", kind: "fly", what: "a helicopter from Coconut Cove's pad, 50 m up, east over Peel Harbor, south over Mango Market and The Murk to Stilt Town",
    at: [98, 403], yaw: 0, seconds: 90, settleS: 6, cruise: 50,
    path: [[300, 380], [600, 360], [480, 100], [430, 20], [560, -220], [330, -330]] },
];

/** what one update asks of the controls */
export interface Ctl { yaw: number; pitch: number; fwd: boolean; back: boolean; left: boolean; right: boolean; sprint: boolean; jump: boolean; down: boolean; use: boolean; fire: boolean }
/** the player as the runner sees it */
export interface Pose { x: number; y: number; z: number; ground: number; heading: number; speed: number; riding: boolean; onGround: boolean }
/** what the runner can do to the match (page: the offline host and the client prediction; Node: the Match) */
export interface TourApi {
  pose(): Pose;
  teleport(x: number, z: number, yaw: number): void;
  /** the nearest empty vehicle of kind (0 tuk-tuk, 1 helicopter) that is upright or lies on its side (E rights it), or null */
  vehicle(kind: number, x: number, z: number): { x: number; y: number; z: number } | null;
  /** n enemy bots (alive, nearest first) put on a ring r0..r1 m around (x, z); returns how many */
  bringBots(n: number, x: number, z: number, r0: number, r1: number): number;
  /** the nearest living enemy's chest, or null */
  enemy(): { x: number; y: number; z: number } | null;
  /** keep the player alive, and armed */
  heal(): void; arm(): void;
}

/** one update's controls toward the waypoint (tx, tz) */
export function steer(kind: SegKind, p: Pose, look: number, tx: number, tz: number, nx: number, nz: number, cruise: number, dt: number, out: Ctl): void {
  const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  const want = Math.atan2(-(tx - p.x), -(tz - p.z));
  const turn = (from: number, rate: number) => { const e = wrap(want - from), s = rate * dt; return from + (Math.abs(e) <= s ? e : Math.sign(e) * s); };
  out.fwd = out.back = out.left = out.right = out.sprint = out.jump = out.down = out.use = out.fire = false;
  out.pitch = -0.08;
  if (kind === "drive") {
    const err = wrap(want - p.heading);
    // full lock only when slow (a flat-out full-lock turn rolls it): coast into a bend, brake into a hairpin
    const a = Math.abs(err);
    out.left = err > 0.04; out.right = err < -0.04;
    // and slow down ahead of the next bend: the turn at the waypoint (to the one after it) once it is within 18 m
    const near = Math.hypot(tx - p.x, tz - p.z), bend = near < 18 ? Math.abs(wrap(Math.atan2(-(nx - tx), -(nz - tz)) - want)) : 0;
    const vmax = Math.min(12 - 8 * Math.min(1, a / 0.8), 12 - 7 * Math.min(1, bend / 1.2) + near * 0.3);
    out.fwd = p.speed < vmax;
    out.back = p.speed > vmax + 3;
    out.yaw = p.heading;
    return;
  }
  if (kind === "fly") {
    out.yaw = turn(look, 1.6);
    out.fwd = Math.abs(wrap(want - p.heading)) < 0.7;
    const agl = p.y - Math.max(0, p.ground);
    out.jump = agl < cruise; out.down = agl > cruise + 25;
    out.pitch = -0.25;
    return;
  }
  out.yaw = turn(look, 3);
  out.fwd = Math.abs(wrap(want - out.yaw)) < 1.2;
  out.sprint = out.fwd;
}

/** the route's state machine: update(dt) once per frame / tick returns the controls; measuring is true only while a
 * segment's measured part runs */
export function tourRunner(segs: Segment[], api: TourApi, steerFn: typeof steer) {
  const ctl: Ctl = { yaw: 0, pitch: 0, fwd: false, back: false, left: false, right: false, sprint: false, jump: false, down: false, use: false, fire: false };
  const log: string[] = [];
  const res = segs.map((s) => ({ id: s.id, ok: false, stuck: 0, skipped: 0, waypoints: 0, of: s.path.length, runS: 0, note: "" }));
  let si = -1, phase = "next", t = 0, wi = 0, look = 0, best = Infinity, bestT = 0, unstick = 0, frames = 0, tries = 0, placed = 0;
  const say = (m: string) => { log.push(si + ":" + (segs[si]?.id ?? "-") + " " + phase + " " + m); };
  const go = (ph: string) => { phase = ph; t = 0; };
  return {
    ctl, log, results: res,
    get index() { return si; },
    get phase() { return phase; },
    get measuring() { return phase === "run"; },
    get done() { return phase === "done"; },
    update(dt: number): Ctl {
      t += dt;
      const seg = segs[si], p = api.pose(), r = res[si];
      api.heal();
      ctl.fwd = ctl.back = ctl.left = ctl.right = ctl.sprint = ctl.jump = ctl.down = ctl.use = ctl.fire = false;
      switch (phase) {
        case "next": {
          if (p.riding) { go("leave"); break; }
          if (si + 1 >= segs.length) { go("done"); break; }
          si++; const s = segs[si];
          api.teleport(s.at[0], s.at[1], s.yaw); look = s.yaw; ctl.yaw = s.yaw; ctl.pitch = -0.08; wi = 0; tries = 0;
          if (s.kind === "fight") api.arm();
          go("arrive");
          break;
        }
        case "leave": {
          // out of the vehicle before the next teleport: the sim frees the seat, never a teleport
          ctl.use = t % 0.5 < 0.25 || t > 1.5;
          if (!p.riding) go("next");
          else if (t > 6) { say("can't leave the vehicle"); si = segs.length; go("done"); }
          break;
        }
        case "arrive": {
          ctl.yaw = look;
          if (Math.hypot(p.x - seg.at[0], p.z - seg.at[1]) < 4 && p.onGround) {
            if (seg.kind === "drive" || seg.kind === "fly") go("board");
            else { if (seg.kind === "fight") { placed = api.bringBots(seg.bots ?? 6, p.x, p.z, seg.ring?.[0] ?? 10, seg.ring?.[1] ?? 20); r.note = "bots " + placed + "/" + (seg.bots ?? 6); } go("settle"); }
          } else if (t > 4) { if (++tries > 2) { say("never arrived"); go("next"); } else { api.teleport(seg.at[0], seg.at[1], seg.yaw); t = 0; } }
          break;
        }
        case "board": {
          if (p.riding) { look = p.heading; if (wi > 0) { go("run"); bestT = 0; best = Infinity; } else go("settle"); break; }
          const v = wi > 0 ? api.vehicle(seg.kind === "fly" ? 1 : 0, p.x, p.z) : api.vehicle(seg.kind === "fly" ? 1 : 0, seg.at[0], seg.at[1]);
          if (!v) { say("no vehicle"); go("next"); break; }
          if (t === dt) say("boarding the vehicle at " + v.x.toFixed(0) + "," + v.z.toFixed(0));
          const d = Math.hypot(v.x - p.x, v.z - p.z);
          if (d > 4 && t > 0.5) { const a = Math.atan2(p.x - v.x, p.z - v.z); api.teleport(v.x + Math.sin(a) * 2.8, v.z + Math.cos(a) * 2.8, look); t = 0; break; }
          ctl.yaw = Math.atan2(-(v.x - p.x), -(v.z - p.z)); ctl.pitch = Math.atan2(v.y + 0.8 - (p.y + 1.6), Math.max(0.5, d));
          look = ctl.yaw;
          ctl.use = t % 0.6 < 0.3;
          if (t > 8) { say("couldn't board"); go("next"); }
          break;
        }
        case "settle": {
          ctl.yaw = seg.kind === "drive" ? p.heading : look;
          ctl.pitch = -0.08;
          if (seg.kind === "fly") ctl.jump = true;
          if (t >= seg.settleS) { go("run"); best = Infinity; bestT = 0; unstick = 0; frames = 0; }
          break;
        }
        case "run": {
          r.runS = t; frames++;
          if (seg.kind === "look") {
            look += seg.frames ? (2 * Math.PI) / seg.frames : (seg.rate ?? 0.6) * dt;
            ctl.yaw = look; ctl.pitch = -0.08;
            if (seg.frames ? frames >= seg.frames : t >= seg.seconds) { r.ok = true; go("next"); }
            break;
          }
          if (seg.kind === "fight") {
            const e = api.enemy();
            if (e) { ctl.yaw = Math.atan2(-(e.x - p.x), -(e.z - p.z)); ctl.pitch = Math.atan2(e.y - (p.y + 1.6), Math.max(0.5, Math.hypot(e.x - p.x, e.z - p.z))); ctl.fire = true; look = ctl.yaw; }
            else { look += 0.8 * dt; ctl.yaw = look; ctl.pitch = -0.08; }
            if (t >= seg.seconds) { r.ok = placed >= (seg.bots ?? 6); go("next"); }
            break;
          }
          const w = seg.path[wi], d = Math.hypot(w[0] - p.x, w[1] - p.z);
          if (seg.kind === "drive" && !p.riding) { r.stuck++; say("thrown out at " + p.x.toFixed(0) + "," + p.z.toFixed(0)); go("board"); break; }
          if (d < (seg.kind === "fly" ? 30 : seg.kind === "drive" ? 5 : 2.5)) {
            wi++; r.waypoints = wi; best = Infinity; bestT = t;
            if (wi >= seg.path.length) { r.ok = r.stuck === 0; go("next"); }
            break;
          }
          if (d < best - 1) { best = d; bestT = t; }
          if (t - bestT > (seg.kind === "fly" ? 8 : 3) && unstick <= 0) {
            r.stuck++; unstick = 1.5; bestT = t; say("stuck at " + p.x.toFixed(0) + "," + p.z.toFixed(0) + " to wp " + wi);
            // the third time on one stretch: on foot, put the player at the waypoint; in a vehicle, aim for the next one
            if (r.stuck % 3 === 0) { r.skipped++; if (seg.kind !== "drive" && seg.kind !== "fly") api.teleport(w[0], w[1], look); wi++; if (wi >= seg.path.length) { go("next"); break; } }
          }
          const nw = seg.path[Math.min(wi + 1, seg.path.length - 1)];
          steerFn(seg.kind, p, look, w[0], w[1], nw[0], nw[1], seg.cruise ?? 60, dt, ctl);
          if (unstick > 0) {
            unstick -= dt;
            if (seg.kind === "drive") { ctl.fwd = false; ctl.back = true; const l = ctl.left; ctl.left = ctl.right; ctl.right = l; }
            else ctl.jump = seg.kind === "fly" || unstick > 1.2;
          }
          look = ctl.yaw;
          if (t >= seg.seconds) { r.ok = false; r.note = "timed out at wp " + wi + "/" + seg.path.length; go("next"); }
          break;
        }
      }
      return ctl;
    },
  };
}
