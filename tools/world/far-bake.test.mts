import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAR_DIR, FAR_INDEX, poiSourceHash, type FarIndex } from "./far-hash.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const index = JSON.parse(fs.readFileSync(path.join(root, FAR_INDEX), "utf8")) as FarIndex;
const stale: string[] = [], missing: string[] = [];
for (const [id, e] of Object.entries(index.pois)) {
  if (!fs.existsSync(path.join(root, FAR_DIR, id + ".bin"))) missing.push(id);
  else if (poiSourceHash(root, id) !== e.hash) stale.push(id);
}
const n = Object.keys(index.pois).length;
if (!stale.length && !missing.length) { console.log(`far impostors: ${n} baked, all match their POI sources`); process.exit(0); }
for (const id of missing) console.error(`far impostor ${id}: ${FAR_DIR}/${id}.bin is missing`);
for (const id of stale) console.error(`far impostor ${id}: its POI sources changed since the bake`);
console.error(`rebake them on a running prod build: npx tsx tools/world/bake-far.mts --only ${[...stale, ...missing].join(",")}`);
process.exit(1);
