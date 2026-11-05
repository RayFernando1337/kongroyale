// The dark ?ktx2=1 path of Assets.texture(): loads a source's GPU-compressed .ktx2 copy (baked by tools/textures/ktx2.mts
// and listed in public/assets/ktx2.json) instead of the webp/jpg. A lazy chunk, so the default boot never downloads it.
import type * as THREE from "three";
import { assetUrl } from "./assets";
import { CAP_PX } from "./tex-cap";
import { releaseAfterUpload } from "./texture-release";

const SOURCE_EXT = /\.(webp|jpe?g|png)$/i;
let listed: Promise<ReadonlySet<string>> | null = null;

/** the compressed texture for a source path, or null when ktx2.json doesn't list one; mips above poicap are skipped */
export async function ktx2Texture(path: string, load: (ktx2Path: string) => Promise<THREE.CompressedTexture>): Promise<THREE.CompressedTexture | null> {
  listed ??= fetch(assetUrl("assets/ktx2.json")).then((r) => (r.ok ? (r.json() as Promise<{ sources: string[] }>) : { sources: [] })).then((m) => new Set(m.sources)).catch(() => new Set<string>());
  if (!(await listed).has(path.replace(/^\//, ""))) return null;
  const capped = async () => {
    const t = await load(path.replace(SOURCE_EXT, ".ktx2"));
    const m = t.mipmaps;
    let k = 0;
    while (CAP_PX > 0 && k < m.length - 1 && Math.max(m[k].width, m[k].height) > CAP_PX) k++;
    if (k) { t.mipmaps = m.slice(k); t.image = { width: m[k].width, height: m[k].height }; }
    return t;
  };
  const t = releaseAfterUpload(await capped(), async () => { const f = await capped(); t.mipmaps = f.mipmaps; return f.image; });
  return t;
}
