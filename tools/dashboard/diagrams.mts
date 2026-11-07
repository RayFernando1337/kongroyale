// Renders Mermaid diagrams to inline SVG for the "How it's built" page. build.mts runs this as a child process: it reads
// {key: mermaid source} as JSON on stdin and writes {key: {light, dark}} as JSON on stdout. The renderer is the pinned
// Mermaid build in vendor/ (version and sha256 in vendor/README.md), run in the Chromium that Playwright already
// installs for the repo's browser checks, so the dashboard adds no npm dependency and the published page needs no
// script and no network for its diagrams.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINNED_SHA256 = "336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3";

const THEMES = {
  light: { background: "#f7f8f9", primaryColor: "#eceef1", primaryTextColor: "#1d2129", primaryBorderColor: "#9399a5", secondaryColor: "#e3e5e9", tertiaryColor: "#f7f8f9", lineColor: "#5f6573", textColor: "#1d2129", edgeLabelBackground: "#f7f8f9", clusterBkg: "#f1f2f4", clusterBorder: "#c4c8d0", noteBkgColor: "#fff6d6", noteTextColor: "#1d2129", actorBkg: "#eceef1", actorBorder: "#9399a5", actorTextColor: "#1d2129", signalColor: "#5f6573", signalTextColor: "#1d2129", labelBoxBkgColor: "#eceef1", labelTextColor: "#1d2129", altBackground: "#f1f2f4" },
  dark: { background: "#0f1114", primaryColor: "#1a1d22", primaryTextColor: "#eceef2", primaryBorderColor: "#666c78", secondaryColor: "#262a31", tertiaryColor: "#0f1114", lineColor: "#9ba1ad", textColor: "#eceef2", edgeLabelBackground: "#0f1114", clusterBkg: "#14171b", clusterBorder: "#3a3f48", noteBkgColor: "#3a3220", noteTextColor: "#eceef2", actorBkg: "#1a1d22", actorBorder: "#666c78", actorTextColor: "#eceef2", signalColor: "#9ba1ad", signalTextColor: "#eceef2", labelBoxBkgColor: "#1a1d22", labelTextColor: "#eceef2", altBackground: "#14171b" },
};

type MermaidApi = { initialize: (c: object) => void; render: (id: string, src: string) => Promise<{ svg: string }> };

async function main(): Promise<void> {
  const sources = JSON.parse(fs.readFileSync(0, "utf8")) as Record<string, string>;
  const js = zlib.gunzipSync(fs.readFileSync(path.join(HERE, "vendor", "mermaid.min.js.gz")));
  if (crypto.createHash("sha256").update(js).digest("hex") !== PINNED_SHA256) throw new Error("vendor/mermaid.min.js.gz is not the pinned Mermaid build");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: js.toString("utf8") });
    const out: Record<string, { light: string; dark: string }> = {};
    for (const side of ["light", "dark"] as const) {
      await page.evaluate((v) => (window as unknown as { mermaid: MermaidApi }).mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: v, securityLevel: "strict", fontFamily: "sans-serif", fontSize: 16, flowchart: { htmlLabels: false, padding: 14 } }), THEMES[side]);
      for (const [key, src] of Object.entries(sources)) {
        const svg = await page.evaluate(async ([id, s]) => (await (window as unknown as { mermaid: MermaidApi }).mermaid.render(id, s)).svg, ["m-" + side + "-" + Object.keys(sources).indexOf(key), src]);
        (out[key] ??= { light: "", dark: "" })[side] = svg;
      }
    }
    process.stdout.write(JSON.stringify(out));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
