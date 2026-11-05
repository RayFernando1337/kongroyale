// The dark ?ktx2 path of Assets.texture(): loads a source's GPU-compressed .ktx2 copy (baked by tools/textures/ktx2.mts
// and listed in public/assets/ktx2.json) instead of the webp/jpg. =1 loads the shipped mix (UASTC normal maps, ETC1S for
// the rest); =etc1s swaps in the ETC1S alternates of the normal maps, so one A/B can compare both encodings. A lazy chunk,
// so the default boot never downloads it.
import type * as THREE from "three";
import { flag } from "../flags";
import { assetUrl } from "./assets";
import { CAP_PX } from "./tex-cap";
import { releaseAfterUpload } from "./texture-release";

type Manifest = { sources: string[]; etc1s?: string[] };

const MODE = flag("ktx2");
const SOURCE_EXT = /\.(webp|jpe?g|png)$/i;
let listed: Promise<{ sources: ReadonlySet<string>; etc1s: ReadonlySet<string> }> | null = null;

/** the compressed texture for a source path, or null when ktx2.json doesn't list one; mips above poicap are skipped */
export async function ktx2Texture(path: string, load: (ktx2Path: string) => Promise<THREE.CompressedTexture>): Promise<THREE.CompressedTexture | null> {
  if (MODE !== "1" && MODE !== "etc1s") return null;
  listed ??= fetch(assetUrl("assets/ktx2.json"))
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : { sources: [] }))
    .catch((): Manifest => ({ sources: [] }))
    .then((m) => ({ sources: new Set(m.sources), etc1s: new Set(m.etc1s) }));
  const key = path.replace(/^\//, ""), m = await listed;
  if (!m.sources.has(key)) return null;
  const file = path.replace(SOURCE_EXT, MODE === "etc1s" && m.etc1s.has(key) ? ".etc1s.ktx2" : ".ktx2");
  const capped = async () => {
    const t = await load(file);
    const mips = t.mipmaps;
    let k = 0;
    while (CAP_PX > 0 && k < mips.length - 1 && Math.max(mips[k].width, mips[k].height) > CAP_PX) k++;
    if (k) { t.mipmaps = mips.slice(k); t.image = { width: mips[k].width, height: mips[k].height }; }
    return t;
  };
  // A context restore refills the existing level objects rather than swapping the array: shareTexture clones hold the
  // same objects, and restoreAll runs every hook before the next frame, so the clones upload the restored pixels too.
  const t = releaseAfterUpload(await capped(), async () => { const f = await capped(); f.mipmaps.forEach((x, i) => { t.mipmaps[i].data = x.data; }); return f.image; });
  return t;
}
