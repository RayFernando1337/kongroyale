// Copies the project drive's lanes.md into lanes.json: the Updated line, the lanes table and the Recently landed line.
// The "## Plan" bullets become the plan lines; without that section the plan already in lanes.json is kept.
//   npx tsx tools/dashboard/lanes-import.mts [path/to/lanes.md]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkNow } from "./now.mts";
import type { Lane, Now } from "./now.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "lanes.json");
const src = process.argv[2] ?? path.join(os.homedir(), ".capy/drive/project-kongroyale/handoffs/dashboard/lanes.md");
const md = fs.readFileSync(src, "utf8");
const upd = md.match(/^Updated: (\d{4}-\d{2}-\d{2}) by (.+)$/m);
const landed = md.match(/^Recently landed[^:]*: (.+?)\.?$/m);
if (!upd || !landed) throw new Error("lanes.md needs an Updated: DATE by NAME line and a Recently landed line");
const lanes: Lane[] = md.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && !/^\|\s*(Lane|-)/.test(l)).map((l) => {
  const [lane, thread, issue, what, status, next] = l.split("|").slice(1, -1).map((c) => c.trim());
  return { lane, thread, issue, what, status, next };
});
const plan = md.match(/^## Plan\n((?:- .+\n?)+)/m)?.[1].trim().split("\n").map((l) => l.replace(/^- /, ""));
const prev = JSON.parse(fs.readFileSync(out, "utf8")) as Now;
const next: Now = { updated: upd[1], updatedBy: upd[2], source: "project drive handoffs/dashboard/lanes.md", plan: plan ?? prev.plan, lanes, landed: landed[1] };
checkNow(next);
fs.writeFileSync(out, JSON.stringify(next, null, 2) + "\n");
console.log("lanes.json: " + lanes.length + " lanes, updated " + next.updated);
