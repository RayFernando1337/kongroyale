// Reports what a production build makes the browser download, from dist/ after `npm run build`. Report only: it never
// fails on a size. Sizes are as served: raw, and the .gz / .br files precompress.mjs wrote, counted by the rule
// server/static.ts serves them by (a missing, stale or larger sidecar means the file goes out raw).
//   npx tsx tools/check-size.mts                 (markdown tables on stdout)
//   npx tsx tools/check-size.mts --json sizes.json --dist dist
// Three views:
// - entry: the module script index.html loads.
// - boot JS: the entry plus every chunk index.html modulepreloads, the JS that must arrive before the game boots.
// - classes: every file in dist/ by what it is. A JS chunk is a worker when another chunk starts it with
//   `new Worker(new URL("/assets/<chunk>.js", ...))`, boot when it is the entry or a modulepreload, else lazy.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const dist = path.resolve(opt("--dist") ?? "dist"), jsonOut = opt("--json");
const indexFile = path.join(dist, "index.html");
if (!fs.existsSync(indexFile)) { console.error(`check-size: no ${indexFile}; run npm run build first`); process.exit(2); }
if (jsonOut && !path.relative(dist, path.resolve(jsonOut)).startsWith("..")) { console.error("check-size: write --json outside the build, or the next run counts the report"); process.exit(2); }

interface Size { raw: number; gz: number; br: number }
const sizeOf = (file: string): Size => {
  const original = fs.statSync(file), raw = original.size;
  // the rule server/static.ts serves by: a sidecar only when it is at least as new as the file and smaller
  const packed = (ext: string) => { const s = fs.existsSync(file + ext) ? fs.statSync(file + ext) : null; return s && s.mtimeMs >= original.mtimeMs && s.size < raw ? s.size : raw; };
  return { raw, gz: packed(".gz"), br: packed(".br") };
};
const add = (a: Size, b: Size): Size => ({ raw: a.raw + b.raw, gz: a.gz + b.gz, br: a.br + b.br });
const zero = (): Size => ({ raw: 0, gz: 0, br: 0 });

const files: string[] = [];
const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (!/\.(gz|br)$/.test(e.name)) files.push(p); } };
walk(dist);

const html = fs.readFileSync(indexFile, "utf8");
const entryHref = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
if (!entryHref?.includes("/assets/")) { console.error("check-size: index.html has no module script under assets/"); process.exit(2); }
// URLs carry the deploy base (DEPLOY_BASE, e.g. /kong/assets/...) but Vite writes the files at dist/assets/...
const base = entryHref.slice(0, entryHref.indexOf("/assets/") + 1);
const servedPath = (href: string) => path.join(dist, href.startsWith(base) ? href.slice(base.length) : href.replace(/^\//, ""));
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const boot = new Set([entryHref, ...preloads].map(servedPath));

const js = files.filter((f) => f.endsWith(".js"));
const workers = new Set<string>();
for (const f of js) for (const m of fs.readFileSync(f, "utf8").matchAll(/new Worker\(\s*new URL\(\s*["'`]([^"'`]+\.js)["'`]/g)) workers.add(servedPath(m[1]));

const CLASSES: Array<[string, RegExp]> = [
  ["textures", /\.(webp|jpe?g|png|ktx2|avif)$/], ["audio", /\.(ogg|m4a|mp3|flac|wav)$/], ["models", /\.(glb|gltf)$/],
  ["wasm", /\.wasm$/], ["fonts", /\.(woff2?|ttf)$/], ["data", /\.(bin|json|txt|svg)$/], ["html", /\.html$/],
];
const classOf = (f: string) => f.endsWith(".js") ? (boot.has(f) ? "js: boot" : workers.has(f) ? "js: workers" : "js: lazy") : CLASSES.find(([, re]) => re.test(f))?.[0] ?? "other";
const classes = new Map<string, { files: number; size: Size }>();
for (const f of files) { const k = classOf(f), c = classes.get(k) ?? { files: 0, size: zero() }; c.files++; c.size = add(c.size, sizeOf(f)); classes.set(k, c); }
let total = zero(); for (const c of classes.values()) total = add(total, c.size);

const rel = (f: string) => path.relative(dist, f);
const bootRows = [...boot].map((f) => ({ file: rel(f), ...sizeOf(f) })).sort((a, b) => b.gz - a.gz);
const bootTotal = bootRows.reduce((s, r) => add(s, r), zero());
const workerRows = [...workers].filter((f) => fs.existsSync(f)).map((f) => ({ file: rel(f), ...sizeOf(f) })).sort((a, b) => b.raw - a.raw);
const entry = sizeOf(servedPath(entryHref));

const kb = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`;
const row = (name: string, s: Size, extra = "") => `| ${name} |${extra} ${kb(s.raw)} | ${kb(s.gz)} | ${kb(s.br)} |`;
console.log(`# Download size of ${path.relative(process.cwd(), dist) || "."}\n`);
console.log("| what | raw | gz | br |\n|---|---|---|---|");
console.log(row(`entry ${rel(servedPath(entryHref))}`, entry));
console.log(row(`boot JS (entry + ${preloads.length} modulepreloads)`, bootTotal));
console.log(row(`everything in dist (${files.length} files)`, total));
console.log("\n## Boot JS\n\n| file | raw | gz | br |\n|---|---|---|---|");
for (const r of bootRows) console.log(row(r.file, r));
console.log("\n## By class\n\n| class | files | raw | gz | br |\n|---|---|---|---|---|");
for (const [k, c] of [...classes].sort((a, b) => b[1].size.br - a[1].size.br)) console.log(row(k, c.size, ` ${c.files} |`));
console.log("\n## Worker bundles\n\n| file | raw | gz | br |\n|---|---|---|---|");
for (const r of workerRows) console.log(row(r.file, r));
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify({ dist, entry: { file: rel(servedPath(entryHref)), ...entry }, boot: { total: bootTotal, files: bootRows },
    classes: Object.fromEntries([...classes].map(([k, c]) => [k, { files: c.files, ...c.size }])), total, workers: workerRows }, null, 2) + "\n");
}
