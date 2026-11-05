import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FAR_DIR = "public/assets/far";
export const FAR_INDEX = path.join(FAR_DIR, "index.json");

export interface FarIndex { version: number; pois: Record<string, { hash: string; tris: number; bytes: number }> }

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

export function poiSources(root: string, id: string): string[] {
  const shared = path.join(root, "shared/pois");
  const own = files(path.join(root, "client/src/world/pois", id));
  const data = fs.readdirSync(shared).filter((f) => f === id + ".ts" || f.startsWith(id + "-") || f === id).flatMap((f) => (fs.statSync(path.join(shared, f)).isDirectory() ? files(path.join(shared, f)) : [path.join(shared, f)]));
  return [...own, ...data].map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
}

export function poiSourceHash(root: string, id: string): string {
  const h = crypto.createHash("sha256");
  for (const f of poiSources(root, id)) h.update(f + "\0").update(fs.readFileSync(path.join(root, f))).update("\0");
  const map = fs.readFileSync(path.join(root, "shared/world/map.ts"), "utf8").split("\n").find((l) => l.includes(`id: "${id}"`)) ?? "";
  return h.update(map.trim()).digest("hex").slice(0, 16);
}
