// The "Now" block on the front page: the current plan in a few lines and a table of the active lanes (who is working on
// what, and what comes next), read from lanes.json. The Captain keeps handoffs/dashboard/lanes.md in the project drive
// current; lanes-import.mts copies it into lanes.json. checkFresh is what publish.mts runs so a stale file stops the
// publish instead of putting an out-of-date plan on the page.
import fs from "node:fs";

export type Lane = { lane: string; thread: string; issue: string; what: string; status: string; next: string };
export type Now = { updated: string; updatedBy: string; source: string; plan: string[]; lanes: Lane[]; landed: string };

export const MAX_AGE_H = 48;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS: (keyof Lane)[] = ["lane", "thread", "issue", "what", "status", "next"];

/** Reads lanes.json and throws on a missing date, plan or lane field, so the block never renders half-filled. */
export function readNow(file: string): Now {
  const n = JSON.parse(fs.readFileSync(file, "utf8")) as Now;
  if (!DATE.test(n.updated)) throw new Error("lanes.json: updated must be YYYY-MM-DD");
  if (!n.updatedBy || !n.source || !n.landed) throw new Error("lanes.json: needs updatedBy, source and landed");
  if (!Array.isArray(n.plan) || n.plan.length < 1 || n.plan.length > 5) throw new Error("lanes.json: plan is one to five lines");
  n.lanes.forEach((l, i) => {
    for (const k of FIELDS) if (!l[k]) throw new Error("lanes.json: lanes[" + i + "] needs " + k);
  });
  return n;
}

/** Hours since the start of the Updated day (UTC). A date has no time, so this counts from the earliest the update could have been written. */
export function ageHours(n: Now, nowMs: number): number {
  return (nowMs - new Date(n.updated + "T00:00:00Z").getTime()) / 3600000;
}

/** Throws when lanes.json is more than MAX_AGE_H hours old, naming the date and how to refresh it. */
export function checkFresh(n: Now, nowMs: number): void {
  const h = ageHours(n, nowMs);
  if (h > MAX_AGE_H) throw new Error("lanes.json is stale: updated " + n.updated + ", " + Math.floor(h) + " h ago and the limit is " + MAX_AGE_H + " h. Refresh it from handoffs/dashboard/lanes.md with npx tsx tools/dashboard/lanes-import.mts and commit it");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The Now block: plan lines, the lanes table, what landed lately, and the Updated date with a warning pill when the file is past the limit. */
export function renderNow(n: Now, nowMs: number, prLink: (n: number) => string): string {
  const stale = ageHours(n, nowMs) > MAX_AGE_H;
  const head = ["Lane", "Agent thread", "Issue", "What", "Status", "Next"];
  const rows = n.lanes.map((l) => "<tr>" + [l.lane, l.thread, l.issue, l.what, l.status, l.next].map((c, i) => '<td data-label="' + head[i] + '"' + (i === 0 ? ' class="now"' : "") + ">" + esc(c) + "</td>").join("") + "</tr>").join("");
  const landed = esc(n.landed).replace(/#(\d+)/g, (_, d: string) => prLink(Number(d)));
  return "<h2>Now</h2>" +
    '<ul class="list nowplan">' + n.plan.map((p) => "<li>" + esc(p) + "</li>").join("") + "</ul>" +
    '<p class="tech-line">Updated ' + esc(n.updated) + " by " + esc(n.updatedBy) + (stale ? ' <span class="pill s-regressed">older than ' + MAX_AGE_H + " h</span>" : "") + ". Source: " + esc(n.source) + ".</p>" +
    '<div class="table-wrap"><table class="play lanes"><thead><tr>' + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    '<p class="tech">Recently landed: ' + landed + "</p>";
}
