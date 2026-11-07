// Appends one point to tools/dashboard/hillclimb.json, the hill-climb tracker on the dashboard's front page (RAY-237).
// Call it from a PR that claims a CPU, power or smoothness change, or from a release gate, then commit the file:
//   npx tsx tools/dashboard/hillclimb-add.mts --metric main-ms --series rtx-walk-town --value 15.2 --low 14.9 --high 15.6 \
//     --kind measured --at "#290" --pr 290 --build 1a2b3c4 --n 8 --method "gpu-match tour, walk-town p50" --source "handoffs/KONG-93/ab-290/"
// --at is the x-axis label (a PR number, a release tag or "phase 1 target"); --date defaults to today (UTC). A thermal
// point passes --state instead of --value. --dry-run prints the point without writing. The file is checked as a whole
// before it is written, so a bad point never lands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHill } from "./hillclimb.mts";
import type { Hill, HillKind, HillPoint } from "./hillclimb.mts";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "hillclimb.json");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string) => {
  const v = flag(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("--" + name + " is not a number: " + v);
  return n;
};
const point: HillPoint = {
  metric: flag("metric") ?? "",
  series: flag("series") ?? "",
  at: flag("at") ?? "",
  value: num("value"),
  low: num("low"),
  high: num("high"),
  state: flag("state"),
  kind: (flag("kind") ?? "measured") as HillKind,
  pr: num("pr"),
  release: flag("release"),
  build: flag("build") ?? "",
  date: flag("date") ?? new Date().toISOString().slice(0, 10),
  n: num("n") ?? 0,
  method: flag("method") ?? "",
  source: flag("source") ?? "",
  note: flag("note"),
};
for (const k of Object.keys(point) as (keyof HillPoint)[]) if (point[k] === undefined) delete point[k];
const hill = JSON.parse(fs.readFileSync(file, "utf8")) as Hill;
hill.points.push(point);
checkHill(hill);
if (args.includes("--dry-run")) console.log(JSON.stringify(point, null, 2));
else {
  fs.writeFileSync(file, JSON.stringify(hill, null, 2) + "\n");
  console.log("hillclimb: added " + point.metric + "/" + point.series + " at " + point.at + " (" + hill.points.length + " points)");
}
