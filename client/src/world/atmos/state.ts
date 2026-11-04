// Atmos state: one object every atmos sub-system reads from (sky, clouds, sun/CSM, env, fog, post). Presets are the
// "look" — midday is the game; dawn, night, rain and jungle are staged looks for their views. Colours are LINEAR
// radiance values (HDR) that land on the target art's sRGB values after Neutral tone mapping + grade.
import * as THREE from "three";
import type { GradeParams } from "./grade";
import { flag } from "../../flags";

export type PresetId = "midday" | "dawn" | "night" | "rain" | "jungle";

export interface AtmosPreset {
  id: PresetId;
  /** sun elevation / azimuth in degrees. az: 0 = north (-Z), 90 = east (+X) */
  sunElev: number;
  sunAz: number;
  /** DirectionalLight colour × intensity (three "physical" units) */
  sunColor: string;
  sunIntensity: number;
  /** the SKY as it must look ON SCREEN: [elevation°, sRGB hex] measured on the target art. index.ts inverts the grade
   *  (grade.ts skyTable) so tone map + grade land on these exact colours */
  sky: Array<[number, string]>;
  /** sun halo: the DISPLAY colour the sky whitens to near the sun (inverted like the sky), strength, halo radius
   *  (radians), disc size in degrees, broad sun-shaft strength */
  glowColor: string;
  glow: number;
  glowSize?: number;
  discDeg: number;
  rays?: number;
  /** sun glare (post lens veil) strength when the sun is in / just outside the frame (0 = off), and how far its colour
   *  is pulled from the halo colour toward white (0.6 midday; dawn keeps a gold bloom) */
  glare?: number;
  glareWhite?: number;
  /** desaturation of the sky inside the halo before the whitening (0 = a plain mix) */
  glowDesat?: number;
  /** warm band along the horizon toward the sun */
  sunHorizon?: string;
  sunHorizonAmt?: number;
  /** high cirrus / altostratus layer in the sky dome: coverage 0..1, opacity, lit + shade colours */
  cirrus?: number;
  cirrusOpacity?: number;
  cirrusLit?: string;
  cirrusShade?: string;
  /** IRRADIANCE sky (env.ts — the fill light, not the visible sky): upper hemisphere zenith → horizon, and the
   *  ground hemisphere (warm bounce from sunlit sand / concrete / leaves) */
  envZenith: string;
  envHorizon: string;
  groundHorizon: string;
  groundNadir: string;
  envIntensity: number;
  /** share of the sun halo kept in the env (warm specular lobe toward the sun) */
  envGlow?: number;
  /** cloud lighting. Ambient colours are DISPLAY targets (sRGB measured on the target art, inverted through the grade);
   *  cloudLit is the TINT of the sunlit part (the sun colour is divided out), cloudSun its strength */
  cloudLit: string;
  cloudSun?: number;
  cloudShade: string;    // side / shaded ambient
  cloudTop: string;      // sky-lit ambient on upward faces
  cloudBase?: string;    // underside ambient
  cloudRim?: number;     // silver-lining strength
  cloudKeyToCam?: number; // stylised key: how far the cloud key light is pulled toward the camera (0 = the real sun)
  cloudWrap?: number;     // sun wrap on clouds: lit fraction (0 = Lambert terminator, 0.6 = a broad wrap)
  cloudBigNormal?: number; // shading follows the lobe-scale form (1) vs every floret (0)
  cloudKeyNearSun?: number; // extra key pull toward the camera for clouds seen near the sun (keeps them white)
  cloudOpacity: number;
  /** soft cotton edge: the fringe's max width in screen pixels (modulated by the floret-scale detail) */
  cloudFuzz?: number;
  /** torn / wispy fringe strength (0 = a clean soft edge), the cotton shading texture on big-on-screen clouds, and
   *  the fringe's width in cloud-width units (capped at cloudFuzz px) */
  cloudWisp?: number;
  cloudCotton?: number;
  cloudFluff?: number;
  /** the lit tops roll off toward these DISPLAY whites (away from the sun / beside it), and the extra sun share on
   *  clouds seen near the sun */
  cloudCapFar?: string;
  cloudCapNear?: string;
  cloudNearSunBoost?: number;
  /** runtime cauliflower detail on big clouds: amplitude (width units) and frequency (per width) */
  cloudDetailAmp?: number;
  cloudDetailFreq?: number;
  /** aerial perspective: blue haze with distance (exponential-height atmosphere), and height fog hugging the water */
  hazeColor: string;
  hazeDensity: number;   // per metre at sea level
  hazeHeight?: number;   // scale height (m)
  hazeSun?: number;      // extra in-scatter toward the sun
  fogColor: string;
  fogDensity: number;    // height-fog density at sea level
  fogHeight: number;     // metres — fog falls off exponentially above sea level with this scale
  /** metres of (sea-level-equivalent) path before the mist starts (post fog; default 180) */
  fogStart?: number;
  /** post */
  exposure: number;
  saturation: number;
  contrast: number;
  warmth: number;
  /** grade: warmth pushed into the shade (keeps whites / creams warm in shadow) */
  shadeWarmth?: number;
  vignette: number;
  bloom: number;
  /** AO strength (0..1, the composite's multiply) and the tone curve's toe (0 = none, 1 = PBR-Neutral's black offset) */
  ao?: number;
  /** SSAO tuning (post.ts): depth bias per metre of distance, radius (m), intensity */
  aoBias?: number;
  aoRadius?: number;
  aoIntensity?: number;
  toe?: number;
  /** grade: contrast pivot (OkLab L) and the highlight knee of the soft gamut compression (grade.ts) */
  pivot?: number;
  knee?: number;
  cloudShadow: number;   // 0..1 strength of cloud shadows on the world (direct sun only)
  /** low-sun rim / backlight strength on lit materials */
  rimLight?: number;
  /** warm multi-bounce on warm albedos (0 = off, 1 = the fill takes the albedo's chroma once more) */
  warmBounce?: number;
  /** canopy sky visibility: strength on the lit materials' fill (0 = off) and the share of the fill kept under a
   *  closed canopy */
  skyVis?: number;
  canopyFill?: number;
  /** volumetric light shafts (post.ts SHAFT_FRAG): strength (0 = off), medium density per metre in the open / under
   *  a closed canopy, share of the post mist's density, march distance (m), Henyey-Greenstein g */
  shafts?: number;
  shaftOpen?: number;
  shaftCanopy?: number;
  shaftMist?: number;
  shaftDist?: number;
  shaftG?: number;
  /** soft ceiling of the in-scatter (share of a sunlit white card; default .2) */
  shaftCap?: number;
  /** screen-space one-bounce GI strength (0 = off) and the fill light an interior loses where no sky reaches it (0..1) */
  gi?: number;
  interiorLoss?: number;
  /** night: star strength, moon radius (deg; the key light's direction), moon radiance + tint */
  stars?: number;
  moonDeg?: number;
  moonI?: number;
  moonTint?: string;
  fireflies?: number;
  /** night: the lighthouse's sweeping beams (nightbeam.ts) */
  lighthouseBeam?: number;
  /** altitude grade strength (warm land, deeper sea from the air); default 1 */
  aerialGrade?: number;
  /** clouds' key lifted toward the zenith (stylised dawn: lit tops, mauve bellies); default 0 */
  cloudKeyUp?: number;
  /** aerial local contrast on the canopy (lit crown tops vs the gaps); default 1 */
  aerialLC?: number;
  /** tint (linear via hex) on the vegetation's own fill light — veg ignores the env (dawn warm, night blue) */
  vegFill?: string;
  /** grade on the vegetation's lit result — rgb multiply (hex, linear) and saturation; default white / 1 */
  vegTint?: string;
  vegSat?: number;
  /** rain: screen-space streaks, rainbow, puddles (post), material wetness (0..1) */
  rainStreaks?: number;
  rainbow?: number;
  puddles?: number;
  wet?: number;
}

// Colour helper: sRGB hex → linear THREE.Color. (three's ColorManagement already decodes hex strings to the linear
// working space — do NOT convertSRGBToLinear again; a double decode crushes every atmos colour.)
export const lin = (hex: string) => new THREE.Color(hex);

export const PRESETS: Record<PresetId, AtmosPreset> = {
  // (filled right below the literal: the staged jungle light derives from midday)
  jungle: null as unknown as AtmosPreset,
  midday: {
    id: "midday",
    sunElev: 42, sunAz: -32,
    sunColor: "#fff1dc", sunIntensity: 4.8,
    // measured on the target art at OUR view cameras' pixel elevations: poi-01 column x=1150 (18.5° #2992d7, 17°
    // #3399da, 15.7° #41a2dc, 14.1° #4ba9df, 12.5° #5bb5e4, 10.8° #6fc2e8, 9.7° #79c9ee), 4.9° #9ed3eb, firefight 25.5°
    // #197cd6, beach 42° #0275d4 (kept a touch off the gamut edge)
    sky: [[0, "#b3e1f1"], [4.9, "#9ed3eb"], [9.7, "#79c9ee"], [10.8, "#6fc2e8"], [12.5, "#5bb5e4"], [14.1, "#4ba9df"],
      [15.7, "#41a2dc"], [17, "#3399da"], [18.5, "#2992d7"], [25.5, "#197cd6"], [42, "#0674d3"], [90, "#0a6cc8"]],
    // a cyan-white halo (a neutral #e8f2f5 mixed with the deep blue drifts violet: #7ca8ee instead of the target #87b1d5,
    // hue 216° vs 207–211°) + a little desaturation inside it
    glowColor: "#bfe4ef", glow: 1.0, glowSize: 0.134, discDeg: 0.9, rays: 0.28, glowDesat: 0.2,
    // lens veil from a sun in / just above the frame (the beach target art's white-hot top-right corner — its camera
    // looks up into the sun; ours sits 13° below it)
    glare: 1.3,
    sunHorizon: "#e8f2f6", sunHorizonAmt: 0.2,
    cirrus: 0.0, cirrusOpacity: 0.0, cirrusLit: "#ffffff", cirrusShade: "#b9cce4",
    // fill: soft blue-grey sky, warm pale horizon band (bounce off the sunlit island), warm sand/leaf ground
    // (a trimmed fill and warm ground keep the shade's punch: lit/shade target 2.6)
    envZenith: "#b3c2d4", envHorizon: "#ddd6c8", groundHorizon: "#a89a82", groundNadir: "#7a6d5a",
    // 0.52 — measured shade vs the target art: concrete .26–.31 (target .28), sand .48–.53 (target .47)
    envIntensity: 0.52, envGlow: 0.35,
    // measured: harbor hero belly #afbdd8–#bdcbe0, flanks #cfd2dc–#dfdfe4; aerial puff shade #b7c9d9–#cbd6e1, lit #e8f0f5;
    // beach lit #f7f8f9, shade #d2d8e1
    // cloud look: a directional, NEUTRAL white key (keyToCam low) so every cloud has a lit and a blue-grey side; the shade /
    // belly a cool neutral with a lavender cast (the target shade is #c5cadc / #b8c0d6, hue ~225°, not cyan-blue 211°;
    // a cyan tint lifts the median saturation above the target .09–.13); a tight fringe (a wide soft one blends every
    // silhouette with the blue sky into a cyan halo band); the lit tops capped below blown white (near-white harbor
    // target ~.35 %) while the beach clouds near the sun keep their brilliance (keyNearSun + rim); crisp edges, floret-scale
    // shading and cauliflower detail so ground-view clouds never read as smooth grey balloons; detail noise only a soft
    // irregularity (the sculpted florets carry the cauliflower)
    cloudLit: "#fffdfa", cloudSun: 1.75, cloudShade: "#a4aec3", cloudTop: "#e8ecf1", cloudBase: "#939db3", cloudRim: 1.0,
    cloudKeyToCam: 0.05, cloudKeyNearSun: 0.3, cloudWrap: 0.2, cloudBigNormal: 0.45, cloudFuzz: 3.5, cloudOpacity: 1.0,
    cloudDetailAmp: 0.02, cloudDetailFreq: 2.4, cloudWisp: 0.35, cloudCotton: 0.5, cloudFluff: 0.009,
    cloudCapFar: "#f0f2f5", cloudCapNear: "#fcfcfd", cloudNearSunBoost: 0.5,
    // 1/2600: land at 1–2 km needs a light blue depth cue from the drop and the hills
    hazeColor: "#a9d3ef", hazeDensity: 1 / 2600, hazeHeight: 700, hazeSun: 1.2,
    fogColor: "#dbeefb", fogDensity: 0.0, fogHeight: 30,
    // grade: a soft toe (PBR-Neutral's full black offset crushed the darkest 1 % to L* 0.01, the target keeps ~0.07, and
    // made up to 1.2 % zero-channel pixels); the highlight knee at 0.985 so lit cloud tops / foam reach #f8–#fe (near-white
    // share beach 3.3 %, firefight 1.5 %, harbor 1.4 % vs the targets' 3.1 / 1.2 / 0.3); contrast about pivot .70 (mids
    // down, the lit sand / whites kept) and exposure tuned to the targets' mid-tone L* (harbor p50 ~.546, firefight ~.540).
    // The sky / clouds are inverse-graded, they do not move with it.
    exposure: 0.93, saturation: 1.1, contrast: 1.33, pivot: 0.7, knee: 0.985, warmth: 0.015, shadeWarmth: 0.11, vignette: 0.03, bloom: 0.3,
    // AO: contact-weighted, small depth bias (stones / crates / feet stay grounded)
    ao: 1.0, toe: 0.15, aoBias: 0.004, aoRadius: 0.75, aoIntensity: 2.2,
    // warm multi-bounce on warm albedos (sand in palm shade: hue 34°, S .35+ instead of a grey #92897a S .17)
    cloudShadow: 0.88, rimLight: 0.12, warmBounce: 1.2,
    // jungle god rays — humid air under the canopy, a whisper in the open
    shafts: 1.0, shaftOpen: 0.00015, shaftCanopy: 0.05, shaftMist: 0, shaftDist: 40, shaftG: 0.45,
    gi: 3.0, interiorLoss: 0.62,
  },
  dawn: {
    id: "dawn",
    // 13° / -44°: the disc hangs just above the stilt-town treeline at the sky-01-dawn frame's right edge (lower, it
    // sits behind the treeline), with its glitter on the lagoon
    sunElev: 13, sunAz: -44,
    sunColor: "#ffc690", sunIntensity: 2.4,
    // measured on the target art at OUR dawn camera's elevations: 30° #93829f–#a682a7 (lavender-mauve), 22° #b39dac,
    // 18° #f3c5bf (peach-pink), 13° #fdcdb1 (peach), gold toward the sun #fcf7af / #f4cc3a
    // (display targets kept ≤ ~246 in R: brighter saturated golds need 3× radiance through the tone curve's shoulder
    // and wash the haze / bloom — the glow carries the brightest gold)
    sky: [[0, "#f4d49c"], [4, "#f2cda2"], [9, "#efc6aa"], [14, "#e9bdb2"], [19, "#dcacb4"], [24, "#bf9cb0"], [30, "#9d88a8"],
      [50, "#8b80a8"], [90, "#7e78a4"]],
    // a GOLD lens bloom with a gentle veil (.45: a stronger one washes the whole sun side milky and the clouds beside the
    // sun to pale pink), a tight gold halo with soft crepuscular streaks
    glowColor: "#f7c97e", glow: 1.0, glowSize: 0.15, discDeg: 1.4, rays: 0.35, glare: 0.45, glareWhite: 0.12,
    sunHorizon: "#ffe3a0", sunHorizonAmt: 0.8,
    cirrus: 0.24, cirrusOpacity: 0.2, cirrusLit: "#f6c0c4", cirrusShade: "#b8a0c4",
    envZenith: "#ab9cbc", envHorizon: "#f2c9a6", groundHorizon: "#b09078", groundNadir: "#6a5448",
    envIntensity: 0.95, envGlow: 0.6,
    // dawn clouds: the masses are lit from the low sun on the RIGHT — the key LIFTED toward the zenith (cloudKeyUp) lights
    // every mass's TOP peach-gold, the sun-side flanks and rims peach, the lee sides and bellies mauve (a key pulled toward
    // the camera lights the front faces evenly into flat pink balloons; a strong rim draws a pale outline round every
    // cloud). Measured on the target art: lit #fdd0b0 / #fdcebb (L* .86), mid dusty rose #d2a2ab, shade mauve #ac869e
    // (hue ~320°, not lavender-blue); crisp 2 px edges, no wisps, floret shading so the cauliflower reads
    cloudLit: "#ffcf9e", cloudSun: 6.5, cloudShade: "#9a5a92", cloudBase: "#70508c", cloudTop: "#f4a6c0", cloudRim: 0.2,
    cloudKeyToCam: 0.1, cloudKeyUp: 1.3, cloudKeyNearSun: 0.1, cloudWrap: 0.06, cloudBigNormal: 0.4, cloudOpacity: 1.0, cloudFuzz: 1.6,
    cloudCotton: 0.65, cloudWisp: 0.1, cloudDetailAmp: 0.02, cloudDetailFreq: 2.6,
    vegFill: "#f2d4cf",
    // dawn-graded foliage (no noon lime): warmer, a touch darker and less saturated than noon
    vegTint: "#f4dccb", vegSat: 0.82,
    hazeColor: "#f3cdbd", hazeDensity: 1 / 4200, hazeHeight: 400, hazeSun: 1.0,
    // the mist runs in the post's final pass (every surface incl. foliage + far water), banded; the stilt-town lagoon is
    // small (the far shore is 100–170 m out, the volcano 765 m), so dense, low mist bands start at ~70 m and hug the far shore
    fogColor: "#ffe6d6", fogDensity: 0.0065, fogHeight: 7, fogStart: 70,
    exposure: 1.0, saturation: 1.3, contrast: 1.22, pivot: 0.6, warmth: 0.1, shadeWarmth: 0.05, vignette: 0.06, bloom: 0.45,
    ao: 1.0, toe: 0.85, aoBias: 0.004, aoRadius: 0.75, aoIntensity: 2.0,
    cloudShadow: 0.15, rimLight: 0.9,
    shafts: 1.0, shaftOpen: 0.0004, shaftCanopy: 0.01, shaftMist: 1.0, shaftDist: 400, shaftG: 0.6,
    gi: 3.0, interiorLoss: 0.62,
  },
  // sky-02-night: a deep indigo sky full of stars and a huge moon, readable, never murky. The key
  // light IS the moon (the SunLight moves to the moon's direction, cool blue-white, dim); the fill is a strong saturated
  // blue sky so shade stays readable; the sky stops are the target art's (zenith navy #020a34 → the glowing blue
  // horizon band #2a70c8 under the clouds); a big crater-textured moon, stars, moon-lit cumulus with blue-white rims
  night: {
    id: "night",
    sunElev: 21, sunAz: -91,
    sunColor: "#9db7ff", sunIntensity: 1.35,
    sky: [[0, "#2a6cc2"], [3, "#1d58ae"], [7, "#11439a"], [12, "#0a3284"], [18, "#05246e"], [26, "#031a5a"], [38, "#021146"], [55, "#010a36"], [90, "#01062a"]],
    glowColor: "#6f9ee6", glow: 0.9, glowSize: 0.18, discDeg: 0.0, rays: 0.0, glare: 0.0, glowDesat: 0.0,
    sunHorizon: "#2f78cc", sunHorizonAmt: 0.25,
    cirrus: 0.0, cirrusOpacity: 0.0,
    envZenith: "#3a5cb4", envHorizon: "#4a70c4", groundHorizon: "#26406e", groundNadir: "#16264a",
    envIntensity: 0.62, envGlow: 0.2,
    // the target art's night cumulus: pale blue-white moon-lit tops (#b7d8f4), saturated blue shade (#4e89d3 → #267dcf)
    cloudLit: "#a9c6ff", cloudSun: 1.3, cloudShade: "#2d5fb4", cloudTop: "#5e8ed8", cloudBase: "#1d4796", cloudRim: 0.9,
    cloudKeyToCam: 0.25, cloudKeyNearSun: 0.4, cloudWrap: 0.3, cloudBigNormal: 0.6, cloudFuzz: 5, cloudOpacity: 1.0,
    cloudDetailAmp: 0.012, cloudDetailFreq: 2.2, cloudWisp: 0.6, cloudCotton: 0.35, cloudFluff: 0.011,
    cloudCapFar: "#b9d6f4", cloudCapNear: "#cfe2f8", cloudNearSunBoost: 0.3,
    hazeColor: "#2a4f9a", hazeDensity: 1 / 3200, hazeHeight: 500, hazeSun: 0.6,
    fogColor: "#3263b0", fogDensity: 0.0012, fogHeight: 8, fogStart: 60,
    exposure: 1.05, saturation: 1.08, contrast: 1.18, pivot: 0.5, knee: 0.985, warmth: -0.02, shadeWarmth: -0.12, vignette: 0.04, bloom: 0.6,
    ao: 1.0, toe: 0.12, aoBias: 0.004, aoRadius: 0.75, aoIntensity: 2.0,
    cloudShadow: 0.0, rimLight: 0.35, warmBounce: 0.3,
    shafts: 0.6, shaftOpen: 0.0002, shaftCanopy: 0.01, shaftMist: 0.6, shaftDist: 200, shaftG: 0.6,
    gi: 3.0, interiorLoss: 0.62,
    stars: 1.0, moonDeg: 5.2, moonI: 1.05, moonTint: "#e8efff", fireflies: 1, lighthouseBeam: 1, vegFill: "#9cb2e2",
    // the target art's night foliage is DARK and saturated (#173207–#3f5a0a, V .2–.35), not noon lime (V .39, S .54)
    vegTint: "#a8b4b8", vegSat: 1.3,
  },
  // sky-03-rain: a tropical rain squall passing over the island: sheets of sunlit rain, wet glossy
  // palm leaves, puddles on a dirt road reflecting a yellow BANANA CO. container, a rainbow over the bay, dramatic clouds.
  // A low warm sun BEHIND the camera (the rainbow sits round the antisolar point, ~42°), a muted grey-blue sky with
  // breaks, heavy cumulus with grey bases, everything wet, rain streaks, puddle mirrors
  rain: {
    id: "rain",
    sunElev: 22, sunAz: -65,
    sunColor: "#ffe7c4", sunIntensity: 4.2,
    // the target art's squall sky: #3d6990 at the top of frame, #54717c at the right, a bright band at the sea
    sky: [[0, "#b4d2de"], [4, "#8fb4c8"], [10, "#6f96b2"], [20, "#5a82a3"], [32, "#4a7298"], [55, "#3d6690"], [90, "#365c86"]],
    glowColor: "#f6f1e4", glow: 0.6, glowSize: 0.14, discDeg: 0.9, rays: 0.0, glare: 0.0, glowDesat: 0.2,
    sunHorizon: "#e9ecea", sunHorizonAmt: 0.2,
    cirrus: 0.3, cirrusOpacity: 0.25, cirrusLit: "#f2f2ee", cirrusShade: "#9aa7b4",
    envZenith: "#a9b6c4", envHorizon: "#d2d4cf", groundHorizon: "#9a8f7c", groundNadir: "#6e6454",
    envIntensity: 0.62, envGlow: 0.3,
    cloudLit: "#fffaf2", cloudSun: 1.8, cloudShade: "#7e8898", cloudTop: "#dde1e6", cloudBase: "#566070", cloudRim: 0.5,
    cloudKeyUp: 0.7, cloudKeyToCam: 0.0, cloudKeyNearSun: 0.35, cloudWrap: 0.3, cloudBigNormal: 0.65, cloudFuzz: 8, cloudOpacity: 1.0,
    cloudDetailAmp: 0.012, cloudDetailFreq: 2.2, cloudWisp: 0.9, cloudCotton: 0.4, cloudFluff: 0.012,
    cloudCapFar: "#eef0f2", cloudCapNear: "#f8f9fa", cloudNearSunBoost: 0.4,
    hazeColor: "#b3c3cf", hazeDensity: 1 / 1500, hazeHeight: 600, hazeSun: 0.8,
    fogColor: "#c8d4dc", fogDensity: 0.0, fogHeight: 30,
    exposure: 0.97, saturation: 1.12, contrast: 1.28, pivot: 0.66, knee: 0.985, warmth: 0.03, shadeWarmth: 0.08, vignette: 0.03, bloom: 0.35,
    ao: 1.0, toe: 0.15, aoBias: 0.004, aoRadius: 0.75, aoIntensity: 2.2,
    cloudShadow: 0.0, rimLight: 0.25, warmBounce: 1.0,
    shafts: 1.0, shaftOpen: 0.0012, shaftCanopy: 0.012, shaftMist: 0, shaftDist: 160, shaftG: 0.5,
    gi: 3.0, interiorLoss: 0.62,
    rainStreaks: 0.8, rainbow: 1.0, puddles: 1.0, wet: 1.0,
    // wet foliage: deeper, richer greens (the target art's glossy dark leaves)
    vegTint: "#dfe6dc", vegSat: 1.12,
  },
};
// biome-02-jungle's staged light (the target art's signature: god rays slanting through the canopy
// onto the path). The game's midday sun (az −32°, el ~58°) sits 77° to the left of the trail camera, where the air's
// forward scattering is ~1/5 of a backlit view: the view stages the sun ahead-left of the path (like the target art)
// with a denser forest medium. Everything else is midday.
PRESETS.jungle = { ...PRESETS.midday, id: "jungle", sunElev: 42, sunAz: 22, shafts: 2.0, shaftCanopy: 0.09, shaftDist: 45, shaftG: 0.5, shaftCap: 0.28 };

/** the composite's grade parameters for a preset (grade.ts replica) */
export function gradeParams(p: AtmosPreset): GradeParams {
  return { exp: p.exposure, toe: p.toe ?? 1, sat: p.saturation, con: p.contrast, warm: p.warmth, shade: p.shadeWarmth ?? 0.05, piv: p.pivot ?? 0.55, knee: p.knee ?? 0.96 };
}

/** unit vector pointing from the world toward the sun */
export function sunDirection(elevDeg: number, azDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevDeg), az = THREE.MathUtils.degToRad(azDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/** The live atmos state shared by all atmos sub-systems and published on ctx.shared.get("atmos"). */
export class AtmosState {
  preset: AtmosPreset = PRESETS.midday;
  readonly sunDir = new THREE.Vector3();
  readonly sunColorLin = new THREE.Color();
  /** wind drift of the cloud layer, metres (x, z) — animated from ctx time */
  readonly cloudDrift = new THREE.Vector2();
  readonly listeners: Array<(s: AtmosState) => void> = [];

  constructor() { this.apply(PRESETS.midday); }

  apply(p: AtmosPreset) {
    // dev: ?sun=elev,az overrides the preset's sun (lighting experiments / comparing alternatives)
    try {
      const o = flag("sun");
      if (o && o.length === 2 && o.every(Number.isFinite)) p = { ...p, sunElev: o[0], sunAz: o[1] };
      // dev: ?atmosp=key:value,key:value overrides preset fields (tuning sheets without code edits; hex colours as 'c0ffee')
      const ov = flag("atmosp");
      if (ov) {
        const q: Record<string, unknown> = { ...p };
        for (const kv of ov.split(",")) {
          const [k, v] = kv.split(":");
          if (!k || v === undefined) continue;
          q[k] = /^[0-9a-f]{6}$/i.test(v) ? "#" + v : Number.isFinite(+v) ? +v : v;
        }
        p = q as unknown as AtmosPreset;
      }
    } catch { /* no location (tests) */ }
    this.preset = p;
    sunDirection(p.sunElev, p.sunAz, this.sunDir);
    this.sunColorLin.copy(lin(p.sunColor));
    for (const l of this.listeners) l(this);
  }
  onChange(fn: (s: AtmosState) => void) { this.listeners.push(fn); }
}

/** debug toggles: ?atmos=noao,nogr,nobloom,nosmaa,nosharpen,noshadow,noclouds,nopost,nofog,nocloudshadow */
export function atmosFlags(): Set<string> {
  return new Set(flag("atmos"));
}
