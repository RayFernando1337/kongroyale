// Kong development views + staging (turntable, face / feet / hand close-ups, LOD check, animation sheets). Owned by the
// actors area; showcase.ts merges `views` and calls `stage`.
// Turntable subject: (330, ground 0.97, -250) facing north (-Z), unarmed idle. Cameras are ABSOLUTE (ground baked in)
// so dune slopes under the camera don't shift the frame. Capture with
//   node tools/shot.mjs wip-kong-3q wip-kong-face wip-kong-front wip-kong-side wip-kong-back --modules atmos,terrain,showcase
import { outfitFor } from "./outfit-pick";
import * as THREE from "three";
import type { WorldModule } from "../world/module";
import type { WorldCtx } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import { createKong } from "./kong";
import type { KongPose } from "./api";
import { flag } from "../flags";

const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });

export const pose = (x: number, y: number, z: number, yaw: number, extra: Partial<KongPose> = {}): KongPose => ({
  x, y, z, yaw, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: "pistol", team: 0, friendly: true, ...extra,
});

/** advance a kong to a representative animation phase; keep animating live, freeze in shot mode (deterministic frames) */
export function hold(ctx: WorldCtx, k: Awaited<ReturnType<typeof createKong>>, p: KongPose, seconds: number) {
  const steps = Math.max(1, Math.round(seconds * 60));
  // a moving kong really travels (planted feet: a treadmill kong would drag its stance foot): it walks INTO its staged
  // spot over the warm-up, ending exactly at (x, z)
  const moving = (p.state === "move" || p.state === "slide") && Math.hypot(p.vx, p.vz) > 0.05;
  const x0 = p.x, z0 = p.z;
  const n = moving ? Math.max(steps, 90) : steps, span = n / 60;
  if (moving) { p.x = x0 - p.vx * span; p.z = z0 - p.vz * span; }
  for (let i = 0; i < n; i++) { if (moving) { p.x += p.vx / 60; p.z += p.vz / 60; } k.apply(p, 1 / 60); }
  if (moving) { p.x = x0; p.z = z0; }
  if (!ctx.shotMode) {
    // live: loop the walk through the spot (−1.5 s … +1.5 s of travel), the feet re-plant on the wrap
    let tt = 0;
    ctx.onUpdate((dt) => { if (moving) { tt = (tt + dt) % 3; p.x = x0 + p.vx * (tt - 1.5); p.z = z0 + p.vz * (tt - 1.5); } k.apply(p, dt); });
  }
}

const G = 2.0;                         // turntable pedestal top (absolute, so terrain edits never shift the frames)
const TT = { x: 330, z: -250 };
const ANIM_X = (i: number) => 331 + (i - 5.5) * 2.3;
/** face sheet row (kong-faces): 5 kongs 1.25 m apart (idle … wow left → right) on the pedestal plane, facing the camera (−Z) */
const FX = (i: number) => 336 - (i - 2) * 1.25, FZ = -238;
const tt = (dx: number, y: number, dz: number, tx: number, ty: number, tz: number, fov: number, stage = "kong-turntable"): CamSpec =>
  V([TT.x + dx, G + y, TT.z + dz], [TT.x + tx, G + ty, TT.z + tz], { fov, stage });

export const views: Record<string, CamSpec> = {
  // turntable (kong fills ~85% of the frame height)
  "wip-kong-front": tt(0, 1.05, -4.0, 0, 1.0, 0, 34),
  "wip-kong-side": tt(4.0, 1.05, 0, 0, 1.0, 0, 34),
  "wip-kong-back": tt(0, 1.05, 4.0, 0, 1.0, 0, 34),
  "wip-kong-3q": tt(2.9, 1.35, -2.9, 0, 1.0, 0, 34),
  // (the Blender kong's head sits lower in the shoulders — re-aimed at the face, not the crown)
  "wip-kong-face": tt(0.75, 1.64, -1.5, 0, 1.53, -0.12, 26),
  // detail close-ups
  "wip-kong-feet": tt(0.95, 0.3, -0.8, 0.2, 0.12, -0.08, 30),
  "wip-kong-heel": tt(0.55, 0.4, 1.05, 0.18, 0.14, 0.05, 30),
  "wip-kong-hand": tt(1.45, 1.05, -1.3, 0.5, 0.72, -0.12, 30),
  "wip-kong-shorts": tt(0.35, 0.8, -1.9, 0, 0.78, 0, 32),
  // lo LOD at ~41 m through a long lens
  "wip-kong-lo": V([352, 4, -285], [TT.x, G + 1.0, TT.z], { fov: 4.2, stage: "kong-turntable" }),
  // perf: 50 kongs within 30 m of the camera (mixed states + weapons) — bench with the kongs shown / hidden
  "wip-kong-50": V([331, 3.2, -262], [331, 1.2, -240], { fov: 70, rel: true, stage: "kong-50" }),
  // friend / foe readability + LOD tiers at gameplay lens (fov 72, eye 1.7 m): foes (red rim) at 6–60 m, friends (cyan)
  // interleaved — 15–30 m foes must stay brown with a thin red edge, not blood-red fuzzballs
  // (on the lobby islet's cleared west beach, the warm-up island)
  "wip-kong-foes": V([-80, 1.7, 993], [-84, 1.2, 1050], { fov: 72, rel: true, stage: "kong-foes" }),
  // animation sheet: 12 kongs in different states, front / profile, + close halves
  "wip-anim-sheet": V([331, 2.6, -263], [331, 1.4, -250], { fov: 55, rel: true, stage: "anim-sheet" }),
  "wip-anim-profile": V([331, 2.6, -263], [331, 1.4, -250], { fov: 55, rel: true, stage: "anim-profile" }),
  "wip-anim-a": V([ANIM_X(2.5), 1.7, -258.5], [ANIM_X(2.5), 1.6, -250], { fov: 50, rel: true, stage: "anim-sheet" }),
  "wip-anim-b": V([ANIM_X(8.5), 1.7, -258.5], [ANIM_X(8.5), 1.6, -250], { fov: 50, rel: true, stage: "anim-sheet" }),
  "wip-anim-pa": V([ANIM_X(2.5), 1.7, -258.5], [ANIM_X(2.5), 1.6, -250], { fov: 50, rel: true, stage: "anim-profile" }),
  // face sheet: idle / aim / hurt / victory / wow expressions side by side, eye level (+ a 4K crop per head)
  "wip-kong-faces": V([FX(2), G + 1.75, FZ - 5.2], [FX(2), G + 1.45, FZ], { fov: 40, stage: "kong-faces" }),
  // … heads large: aim / hurt / victory (left → right)
  "wip-kong-faces-near": V([FX(2), G + 1.78, FZ - 2.9], [FX(2), G + 1.68, FZ], { fov: 30, stage: "kong-faces" }),
  "wip-anim-pb": V([ANIM_X(8.5), 1.7, -258.5], [ANIM_X(8.5), 1.6, -250], { fov: 50, rel: true, stage: "anim-profile" }),
};

const OUTFITS = (() => { try { const v = flag("outfits"); return v === null ? null : Number(v || 1); } catch { return null; } })();
const staged = new Set<string>();
export async function stage(ctx: WorldCtx, s: string) {
  if (staged.has(s)) return; staged.add(s);
  const ground = (x: number, z: number) => Math.max(0, ctx.terrain.height(x, z));
  if (s === "kong-turntable") {
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.35, 4, 48), new THREE.MeshStandardMaterial({ color: "#b9ad97", roughness: 0.9 }));
    ped.position.set(TT.x, G - 2, TT.z); ped.receiveShadow = true; ped.castShadow = true; ctx.scene.add(ped);
    const k = await createKong(ctx, { variant: 1 });
    ctx.scene.add(k.object);
    hold(ctx, k, pose(TT.x, G, TT.z, 0, { weapon: null }), 0.5);
  }
  if (s === "kong-faces") {
    const ex = ["idle", "aim", "hurt", "victory", "wow"] as const;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 2.4), new THREE.MeshStandardMaterial({ color: "#b9ad97", roughness: 0.9 }));
    deck.position.set(FX(2), G - 2, FZ); deck.receiveShadow = true; ctx.scene.add(deck);
    for (let i = 0; i < ex.length; i++) {
      const k = await createKong(ctx, { variant: 40 + i });
      ctx.scene.add(k.object);
      k.animator.expression = ex[i];
      hold(ctx, k, pose(FX(i), G, FZ, 0, { weapon: null }), 0.7);
    }
  }
  if (s === "kong-50") {
    const W = ["pistol", "smg", "ar", "shotgun", "sniper", null] as const;
    const states: Array<Partial<KongPose>> = [{ state: "idle" }, { state: "move", vz: -1.6 }, { state: "move", vz: -5.5 }, { state: "move", crouch: true, vz: -1.2 }, { state: "emote" }, { state: "jump", vy: 3 }];
    const R = (i: number, k: number) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    for (let i = 0; i < 50; i++) {
      const a = R(i, 1) * Math.PI * 1.2 - Math.PI * 0.6, d = 4 + Math.sqrt(R(i, 2)) * 26;
      const x = 331 + Math.sin(a) * d, z = -262 + Math.cos(a) * d;
      const st = states[i % states.length], yaw = R(i, 3) * Math.PI * 2;
      const vz = st.vz ?? 0, c = Math.cos(yaw), sn = Math.sin(yaw);
      const k = await createKong(ctx, { variant: i });
      // ?outfits[=seed]: the match variety on the 50 — the perf view with hats + tops
      if (OUTFITS !== null) k.setOutfit(outfitFor(i, OUTFITS));
      ctx.scene.add(k.object);
      hold(ctx, k, pose(x, ground(x, z), z, yaw, { ...st, vx: vz * sn, vz: vz * c, weapon: W[i % W.length], team: (i % 4) + 1, friendly: i % 4 === 0 }), 0.3 + R(i, 4));
    }
  }
  if (s === "kong-foes") {
    const W = ["ar", "smg", "pistol", "shotgun", "sniper", "rocket"] as const;
    const dist = [6, 9, 12, 15, 18, 22, 26, 30, 36, 45, 60];
    const list: KongPose[] = [];
    ctx.shared.set("kong:foes", list);            // dev: live tools move these poses (TAA / LOD motion checks)
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i], a = ((i % 2 ? 1 : -1) * (0.08 + 0.3 * (1 - i / dist.length))) * (i % 3 === 2 ? 0.3 : 1);
      const h0 = Math.atan2(57, -4), x = -80 + Math.cos(h0 + a) * d * 0.9, z = 993 + Math.sin(h0 + a) * d;
      const friend = i === 3 || i === 7;
      const k = await createKong(ctx, { variant: 30 + i });
      ctx.scene.add(k.object);
      const p = pose(x, ground(x, z), z, (i * 1.7) % (Math.PI * 2), { weapon: W[i % W.length], team: friend ? 1 : 2 + i, friendly: friend, state: i % 4 === 1 ? "move" : "idle", vx: i % 4 === 1 ? 1.2 : 0 });
      list.push(p);
      hold(ctx, k, p, 0.4 + i * 0.05);
    }
  }
  if (s === "anim-sheet" || s === "anim-profile") {
    const yaw = s === "anim-profile" ? Math.PI / 2 : 0;
    const states: Array<[string, Partial<KongPose>, number]> = [
      ["idle", { weapon: "pistol" }, 0.5], ["walk", { vz: -1.6, weapon: "ar" }, 0.6], ["run", { vz: -5.5, weapon: "smg" }, 0.35], ["sprint", { vz: -7, sprint: true, weapon: null }, 0.5],
      ["crouch", { crouch: true, weapon: "shotgun", pitch: 0.3 }, 0.8], ["crouch-walk", { crouch: true, vz: -1.3, vx: -0.25, weapon: "pistol", pitch: 0.05, state: "move" }, 1.35], ["slide", { crouch: true, sprint: true, vz: -6, weapon: "pistol", state: "move" }, 0.6], ["jump", { state: "jump", vy: 4, weapon: "pistol" }, 0.4],
      ["freefall", { state: "freefall" }, 1.2], ["glide", { state: "glide" }, 1.2], ["dead", { state: "dead" }, 2], ["emote", { state: "emote" }, 1.3],
    ];
    for (let i = 0; i < states.length; i++) {
      const [, extra, t] = states[i];
      const k = await createKong(ctx, { variant: i });
      ctx.scene.add(k.object);
      const x = ANIM_X(i), z = -250;
      const y = ground(x, z) + (extra.state === "freefall" || extra.state === "glide" ? 2.2 : extra.state === "jump" ? 0.6 : 0);
      // velocities are world-space: rotate the forward/strafe intent with the yaw so profile kongs move the same way
      const vx = extra.vx ?? 0, vz = extra.vz ?? 0, c = Math.cos(yaw), sn = Math.sin(yaw);
      const p = pose(x, y, z, yaw, { team: i % 3, friendly: i % 2 === 0, ...extra, vx: vx * c + vz * sn, vz: -vx * sn + vz * c });
      hold(ctx, k, p, t);
    }
  }
}

const mod: WorldModule = { id: "kong-dev", build() {}, views, stage };
export default mod;
