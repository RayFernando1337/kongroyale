// The client half of the prediction-drift probe: a headless ClientMatch (the browser's real prediction and reconcile
// code) fed frames by drift.mts, driven by an open-loop input script, counting every reconcile correction. Runs in Node
// or, bundled, inside Chromium (V8) or WebKit (JavaScriptCore). --perturb scales the client's trig as a positive control.
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile } from "../../shared/world/terrain-gen";
import { buildStaticWorld } from "../../shared/sim/static-world";
import { B, PS } from "../../shared/sim/player";
import { ClientMatch } from "../../client/src/game/client";
import type { Link } from "../../client/src/game/net";

let now = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });

export type Op = [t: number, kind: 0 | 1 | 2, data?: unknown];
let cm: ClientMatch | null = null;
const up: Array<[number, number[]]> = [];
const corrections: Array<[number, number, number]> = [];
const input = {
  yaw: 0, pitch: 0, mx: 0, mz: 0, buttons: 0, dx: 0, dy: 0,
  poll(o: { mx: number; mz: number; buttons: number; slot: number }) { o.mx = this.mx; o.mz = this.mz; o.buttons = this.buttons; o.slot = 0; },
};
let driving = false;
function drive(t: number) {
  const s = t / 1000;
  if (driving && cm!.started && cm!.pred.st !== PS.Plane && cm!.pred.st !== PS.Freefall && cm!.pred.st !== PS.Glide) {
    input.pitch = 0; input.mx = 0; input.mz = 0; input.buttons = 0;
    if (cm!.pred.st === PS.Ride) { input.mz = Math.floor(s / 6) % 5 === 4 ? -1 : 1; input.mx = Math.floor(s / 1.7) % 3 - 1; if (s % 11 < 0.3) input.buttons = B.JUMP; }
    else if (Math.floor(s * 4) % 2 === 0) input.buttons = B.USE;
    return;
  }
  input.yaw = (s * 0.37) % 6.283185307179586;
  input.pitch = 0;
  input.mz = Math.floor(s / 9) % 4 === 3 ? -1 : 1;
  input.mx = Math.floor(s / 1.3) % 3 - 1;
  let b = 0;
  if (Math.floor(s / 3) % 2 === 0) b |= B.SPRINT;
  if (s % 2.1 < 0.05) b |= B.JUMP;
  if (s % 7 > 6.5) b |= B.CROUCH;
  if (s > 6 && s < 9 && Math.floor(s * 10) % 2 === 0) b |= B.JUMP;
  input.buttons = b;
}

export async function init(island: Uint8Array, drivingMode = false, perturbUlps = 0) {
  driving = drivingMode;
  if (perturbUlps) for (const f of ["sin", "cos", "atan2", "exp", "pow"] as const) { const o = Math[f] as (...a: number[]) => number; (Math as unknown as Record<string, unknown>)[f] = (...a: number[]) => o(...a) * (1 + perturbUlps * 2.220446049250313e-16); }
  const td = decodeTerrainFile(island.buffer.slice(island.byteOffset, island.byteOffset + island.byteLength));
  const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
  const link: Link = { offline: false, onJSON: () => {}, onBinary: () => {}, onClose: () => {}, sendJSON: () => {}, sendBinary: (u8) => { up.push([now, Array.from(u8)]); }, close: () => {} };
  cm = new ClientMatch(world, link);
  cm.sink = new Proxy({}, { get: () => () => undefined }) as never;
  cm.onCorrection = (err, stateChange) => { corrections.push([now, err, stateChange ? 1 : 0]); };
}

export function run(ops: Op[]): Array<[number, number[]]> {
  up.length = 0;
  for (const [t, kind, data] of ops) {
    now = t;
    if (kind === 0) cm!.onJSON(data as Record<string, unknown>);
    else if (kind === 1) cm!.onBinary(Uint8Array.from(data as number[]));
    else { drive(t); cm!.update(1 / 144, input as never, true); }
  }
  return up.slice();
}

export function stats() { return { ...cm!.netStats, corrections }; }
