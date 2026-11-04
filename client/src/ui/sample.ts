// View-camera HUD state: for the ui-01-hud view (and, with ?map=1, ui-02-map-screen).
// Geometry: compass centred at ≈346°, minimap ring r≈128 px of 375 (≈205 m at the
// on-foot zoom) sitting ≈30 px north of the player; map-screen circle / flight path / drop pin back-projected
// through the full map's default view (see bigmap.ts VIEW_*).
import type { ConsumableId } from "../../../shared/world/map";
import type { Terrain } from "../../../shared/world/terrain";
import type { HudState } from "./api";
import { flag } from "../flags";

export function sampleHudState(_terrain: Terrain, map = false): HudState {
  const mapShot = map || flag("map");
  const me = { x: 240, z: 485, alive: true };
  return {
    phase: mapShot ? "plane" : "play",
    mode: "solo",
    hp: 100,
    shield: 100,
    alive: 50,
    squadsAlive: 50,
    stormTimer: 85,
    stormShrinking: false,
    inStorm: false,
    stormPhase: 1,
    // heading ≈ 346° (just right of 345)
    yaw: (14 * Math.PI) / 180,
    me: mapShot ? { x: 150, z: -280, alive: true } : me,
    // the wall (purple beyond it) and the white next-zone ring
    safe: mapShot ? { cx: 0, cz: -150, r: 1390 } : { cx: 0, cz: 0, r: 1150 },
    next: mapShot ? { cx: -2, cz: -180, r: 1070 } : { cx: me.x - 8, cz: me.z - 48, r: 205 },
    plane: mapShot ? { x0: -962, z0: -762, x1: 1166, z1: 600 } : null,
    planeT: 0.36,
    dropMarker: mapShot ? { x: 170, z: -136 } : null,
    squad: [],
    ammo: { mag: 30, reserve: 120 },
    hotbar: [
      { kind: "weapon", id: "rocket", rarity: "legendary", count: 150 },
      { kind: "weapon", id: "ar", rarity: "epic", count: 35 },
      { kind: "consumable", id: "leaf-bundle", rarity: "uncommon", count: 2 },
      // a plain banana in slot 4 (the HUD ships a banana sprite for it)
      { kind: "consumable", id: "banana" as unknown as ConsumableId, rarity: "common", count: 2 },
      { kind: "consumable", id: "smoothie", rarity: "uncommon", count: 2 },
    ],
    activeSlot: 0,
    reload: null,
    using: null,
    killfeed: [],
    hitMarker: null,
    damageDirs: [],
    damageNumbers: [],
    interact: null,
    announce: null,
    resurgence: { on: true, countdown: null, final: false },
    scoped: false,
    spectating: null,
    air: null,
    net: { ping: 24, fps: 240 },
    matchTime: 215,
  };
}
