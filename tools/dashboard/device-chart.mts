// Memory by device: reads devices.json (measured, estimated and planned memory points per device class, release by
// release) and draws one plain SVG line chart per metric. build.mts renders the "Memory by device" page from it.
// Colours come from CSS variables in style.css, so the same SVG follows the light and dark themes.
import fs from "node:fs";

export type PointKind = "measured" | "estimate" | "planned";
export type DevicePoint = { slot: string; mb: number; low?: number; high?: number; kind: PointKind; killed?: boolean; build: string; m: string; n: number; date: string; note?: string; work?: string };
export type DeviceLine = { id: string; label: string; setup: "defaults" | "lowmem"; same?: string; points: DevicePoint[] };
export type Ceiling = { mb: number; label: string; kind: "measured" | "estimate" | "target" };
export type DeviceChart = { id: string; title: string; caption: string; measure: string; pending?: string; ceilings: Ceiling[]; lines: DeviceLine[] };
export type Sku = { id: string; name: string; plain: string; supported: boolean; charts: DeviceChart[] };
export type Method = { label: string; device: string; method: string; source: string };
export type Slot = { id: string; label: string; planned?: boolean };
export type Devices = { plain: string; slots: Slot[]; methods: Record<string, Method>; skus: Sku[] };

const KINDS: PointKind[] = ["measured", "estimate", "planned"];

/** Reads devices.json, fills lines that copy another line ("same": "sku/chart/line"), and throws on any point that lacks its method, build, run count or date. */
export function readDevices(file: string): Devices {
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as Devices;
  const slots = new Set(d.slots.map((s) => s.id));
  const lineAt = (ref: string) => {
    const [sku, chart, line] = ref.split("/");
    const found = d.skus.find((s) => s.id === sku)?.charts.find((c) => c.id === chart)?.lines.find((l) => l.id === line);
    if (!found || found.same) throw new Error("devices.json: " + ref + " is not a line with its own points");
    return found;
  };
  for (const sku of d.skus) for (const chart of sku.charts) for (const line of chart.lines) {
    if (line.same) line.points = lineAt(line.same).points;
    const where = sku.id + "/" + chart.id + "/" + line.id;
    for (const p of line.points) {
      const at = where + " at " + p.slot;
      if (!slots.has(p.slot)) throw new Error("devices.json: " + at + " names an unknown release slot");
      if (!KINDS.includes(p.kind)) throw new Error("devices.json: " + at + " has kind " + p.kind);
      if (!Number.isFinite(p.mb) || p.mb <= 0) throw new Error("devices.json: " + at + " has no value");
      if (!d.methods[p.m]) throw new Error("devices.json: " + at + " names an unknown method " + p.m);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error("devices.json: " + at + " has no date");
      if (!p.build) throw new Error("devices.json: " + at + " has no build");
      if (p.kind === "measured" ? !(p.n >= 1) : p.n !== 0) throw new Error("devices.json: " + at + " needs n >= 1 when measured and n = 0 otherwise");
      if (p.kind === "planned" && !p.work) throw new Error("devices.json: " + at + " is planned but names no work");
      if (p.kind !== "measured" && !p.note) throw new Error("devices.json: " + at + " is not measured, so it needs a note saying how it was worked out");
    }
  }
  return d;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A size in MB written in GB of 1,000 MB, as the measurement reports write it: two decimals under 1 GB, one above. */
export function gb(mb: number): string {
  return (mb / 1000).toFixed(mb < 1000 ? 2 : 1) + " GB";
}

/** Draws one chart: releases along the bottom, GB up the side, a line per series, and a horizontal line per ceiling. */
export function renderDeviceChart(chart: DeviceChart, slots: Slot[], compact = false): string {
  const w = compact ? 560 : 960, h = compact ? 360 : 380;
  const left = compact ? 66 : 60, right = compact ? 10 : 20, top = 20, bottom = 44;
  const plotW = w - left - right, plotH = h - top - bottom;
  let max = 0;
  for (const l of chart.lines) for (const p of l.points) max = Math.max(max, p.high ?? p.mb, p.mb);
  for (const c of chart.ceilings) max = Math.max(max, c.mb);
  const maxGB = (max / 1000) * 1.12;
  const step = maxGB <= 1.5 ? 0.25 : maxGB <= 3 ? 0.5 : maxGB <= 10 ? 1 : 2;
  const yTop = Math.max(step, Math.ceil(maxGB / step) * step);
  const xs = (i: number) => left + (plotW / slots.length) * (i + 0.5);
  const ys = (mb: number) => top + plotH - (mb / 1000 / yTop) * plotH;
  const out: string[] = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(chart.title) + '" font-family="-apple-system,Segoe UI,Inter,Roboto,sans-serif" font-size="' + (compact ? 17 : 13) + '">');
  const firstPlanned = slots.findIndex((s) => s.planned);
  if (firstPlanned >= 0) {
    const x0 = left + (plotW / slots.length) * firstPlanned;
    out.push('<rect class="plan-bg" x="' + x0.toFixed(1) + '" y="' + top + '" width="' + (left + plotW - x0).toFixed(1) + '" height="' + plotH + '"/>');
  }
  for (let g = 0; g <= yTop + 1e-9; g += step) {
    const y = ys(g * 1000);
    out.push('<line class="grid" x1="' + left + '" x2="' + (left + plotW) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>');
    out.push('<text class="t" x="' + (left - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + Number(g.toFixed(2)) + " GB</text>");
  }
  slots.forEach((s, i) => out.push('<text class="t' + (s.planned ? " t-plan" : "") + '" x="' + xs(i).toFixed(1) + '" y="' + (top + plotH + 22) + '" text-anchor="middle">' + esc(s.label) + "</text>"));
  for (const c of chart.ceilings) {
    const y = ys(c.mb);
    out.push('<line class="ceil ceil-' + c.kind + '" x1="' + left + '" x2="' + (left + plotW) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>');
  }
  const index = new Map(slots.map((s, i) => [s.id, i]));
  const xOf = (p: DevicePoint) => xs(index.get(p.slot) as number);
  chart.lines.forEach((l, li) => {
    const pts = [...l.points].sort((a, b) => (index.get(a.slot) as number) - (index.get(b.slot) as number));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const solid = a.kind === "measured" && b.kind === "measured";
      out.push('<line class="ln l' + li + (solid ? "" : " ln-plan") + '" x1="' + xOf(a).toFixed(1) + '" y1="' + ys(a.mb).toFixed(1) + '" x2="' + xOf(b).toFixed(1) + '" y2="' + ys(b.mb).toFixed(1) + '"/>');
    }
    for (const p of pts) {
      const x = xOf(p), y = ys(p.mb);
      const tip = "<title>" + esc(l.label + ", " + p.build + ": " + gb(p.mb) + " (" + p.kind + (p.killed ? ", Safari closed the tab" : "") + ")") + "</title>";
      if (p.low !== undefined || p.high !== undefined) out.push('<line class="whisker l' + li + '" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + ys(p.low ?? p.mb).toFixed(1) + '" y2="' + ys(p.high ?? p.mb).toFixed(1) + '"/>');
      if (p.kind === "planned") out.push('<path class="pt-open l' + li + '" d="M' + x.toFixed(1) + " " + (y - 7).toFixed(1) + 'l7 7-7 7-7-7z">' + tip + "</path>");
      else if (p.kind === "estimate") out.push('<circle class="pt-open l' + li + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5.5">' + tip + "</circle>");
      else out.push('<circle class="pt l' + li + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5">' + tip + "</circle>");
      if (p.killed) out.push('<path class="kill" d="M' + (x - 5).toFixed(1) + " " + (y - 19).toFixed(1) + 'l10 10m0-10-10 10"/>');
      if (!compact) out.push('<text class="v l' + li + '" font-size="12" x="' + (x + 8).toFixed(1) + '" y="' + (l.setup === "lowmem" ? y + 18 : y - 8).toFixed(1) + '">' + gb(p.mb).replace(" GB", "") + "</text>");
    }
  });
  out.push("</svg>");
  return out.join("");
}
