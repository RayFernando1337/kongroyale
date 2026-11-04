// Repo lint: rules from AGENTS.md that review used to enforce by hand, checked on the TypeScript syntax tree.
// No dependency beyond the typescript package the build already uses; parse-only, so it runs in a few seconds.
//   npx tsx tools/lint/check.mts              self-test, then lint the repo against tools/lint/baseline.json
//   npx tsx tools/lint/check.mts --self-test  only the self-test
// The baseline counts the violations each file had when a rule arrived (lines with a finding, per rule and file). It
// only shrinks: a file over its count fails, and a file under its count fails until the count is lowered to match, so a
// fix stays fixed. Never raise a count to make a change pass; fix the code instead.
// The self-test runs every rule over tools/lint/fixtures/<rule>/: a line ending in "// lint-expect" must be flagged and no
// other line may be, so a rule that silently stops matching fails here before it lets a real violation through.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINT_DIR = "tools/lint";
const SCAN_DIRS = ["client/src", "shared", "server", "tools"];
const SOURCE_EXT = /\.(ts|mts|js|mjs)$/;

type Hit = { node: ts.Node; message: string };
type Rule = {
  id: string;
  /** which repo files the rule covers (posix path relative to the repo root) */
  applies: (rel: string) => boolean;
  check: (sf: ts.SourceFile) => Hit[];
};
type Finding = { rule: string; file: string; line: number; message: string };
/** rule id -> file -> number of lines with a finding */
type Counts = Record<string, Record<string, number>>;
/** a baseline mismatch; over = the file has more violations than the baseline allows, so its findings get printed */
type Mismatch = { rule: string; file: string; over: boolean; message: string };

// ---- shared-determinism (AGENTS.md rule 2) ----

const RULE2 = "(AGENTS.md rule 2: shared/ runs on Node and in every browser and must give the same result on both)";
const MSG_RANDOM = `Math.random() differs per run: use Rng from shared/sim/rng.ts, seeded from the match seed ${RULE2}`;
const MSG_CLOCK = `wall-clock time in shared/: drive game logic from the match tick (Match.tick, TICK_S in shared/sim/const.ts); time builds and profiles in client/ or tools/ and pass the result in ${RULE2}`;
const MSG_NODE = `Node API in shared/: move it to server/ or tools/ and pass the data in as an argument ${RULE2}`;
const MSG_DOM = `browser-only API in shared/: keep it in client/src/ and pass the data in as an argument ${RULE2}`;
const NODE_GLOBALS = new Set(["process", "Buffer", "require", "__dirname", "__filename", "global", "setImmediate"]);
const DOM_GLOBALS = new Set([
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "getComputedStyle", "matchMedia", "alert",
  "devicePixelRatio", "innerWidth", "innerHeight", "screen", "Image", "Audio", "AudioContext", "OffscreenCanvas",
  "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "HTMLInputElement", "WebGLRenderingContext",
  "WebGL2RenderingContext", "Worker", "WebSocket",
]);
const isNodeModule = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec);

/** an identifier that reads a variable, as opposed to a property name, a declared name or a type */
function isValueRef(n: ts.Identifier): boolean {
  const p = n.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)
    || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === n) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)
    || ts.isBindingElement(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name === n) return false;
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isLabeledStatement(p)) return false;
  return true;
}

const sharedDeterminism: Rule = {
  id: "shared-determinism",
  applies: (rel) => rel.startsWith("shared/"),
  check(sf) {
    const hits: Hit[] = [];
    // a name the file declares itself (a local `screen`, a parameter `location`) is not the global; an ambient
    // `declare const Buffer` only types the global, so it still counts
    const declared = new Set<string>();
    const ambient = (n: ts.Node) => ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent)
      && !!n.parent.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
    const collect = (n: ts.Node): void => {
      if (!ambient(n) && (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
        || ts.isBindingElement(n) || ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n))
        && n.name && ts.isIdentifier(n.name)) declared.add(n.name.text);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const obj = n.expression.text, prop = n.name.text;
        if (obj === "Math" && prop === "random") hits.push({ node: n, message: MSG_RANDOM });
        if (obj === "Date" && prop === "now") hits.push({ node: n, message: MSG_CLOCK });
      }
      if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "Date") hits.push({ node: n, message: MSG_CLOCK });
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isNodeModule(n.moduleSpecifier.text)) hits.push({ node: n, message: MSG_NODE });
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))
        && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && isNodeModule(n.arguments[0].text)) hits.push({ node: n, message: MSG_NODE });
      if (ts.isIdentifier(n) && isValueRef(n) && !declared.has(n.text)) {
        if (n.text === "performance") hits.push({ node: n, message: MSG_CLOCK });
        else if (NODE_GLOBALS.has(n.text)) hits.push({ node: n, message: MSG_NODE });
        else if (DOM_GLOBALS.has(n.text)) hits.push({ node: n, message: MSG_DOM });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  },
};

const RULES: Rule[] = [sharedDeterminism];

// ---- engine ----

const toPosix = (p: string) => p.split(path.sep).join("/");
const parse = (abs: string) => ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);

/** one finding per rule and line: two hits on one line are one site to fix */
function runRule(rule: Rule, sf: ts.SourceFile, file: string): Finding[] {
  const byLine = new Map<number, Finding>();
  for (const h of rule.check(sf)) {
    const line = sf.getLineAndCharacterOfPosition(h.node.getStart(sf)).line + 1;
    if (!byLine.has(line)) byLine.set(line, { rule: rule.id, file, line, message: h.message });
  }
  return [...byLine.values()];
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name), rel = toPosix(path.relative(ROOT, abs));
      if (e.isDirectory()) { if (e.name !== "node_modules" && rel !== `${LINT_DIR}/fixtures`) walk(abs); }
      else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return out.sort();
}

function tally(findings: Finding[]): Counts {
  const counts: Counts = {};
  for (const f of findings) { const r = (counts[f.rule] ??= {}); r[f.file] = (r[f.file] ?? 0) + 1; }
  return counts;
}

/** every file whose count differs from the baseline, and every baseline entry that names nothing real */
function compareBaseline(counts: Counts, baseline: Counts, ruleIds: string[], fileExists: (rel: string) => boolean): Mismatch[] {
  const out: Mismatch[] = [];
  const BASE = `${LINT_DIR}/baseline.json`;
  for (const rule of Object.keys(baseline)) if (!ruleIds.includes(rule)) out.push({ rule, file: BASE, over: false, message: `baseline names unknown rule "${rule}": remove it from ${BASE}` });
  for (const rule of ruleIds) {
    const base = baseline[rule] ?? {}, found = counts[rule] ?? {};
    for (const file of new Set([...Object.keys(base), ...Object.keys(found)])) {
      const allowed = base[file] ?? 0, n = found[file] ?? 0;
      const m = (over: boolean, message: string) => out.push({ rule, file, over, message: `${rule}: ${file} ${message}` });
      if (file in base && (!Number.isInteger(allowed) || allowed < 1)) m(false, `has baseline count ${JSON.stringify(base[file])}; a count must be a positive integer`);
      else if (file in base && !fileExists(file)) m(false, `is in the baseline but does not exist: remove its entry from ${BASE}`);
      else if (n > allowed) m(true, `has ${n} violating line(s), the baseline allows ${allowed}: fix the new one(s) listed above`);
      else if (n < allowed) m(false, `has ${n} violating line(s), fewer than the baseline's ${allowed}: ${n ? `lower its count in ${BASE} to ${n}` : `delete its entry from ${BASE}`} so the fix stays fixed`);
    }
  }
  return out;
}

function selfTest(): string[] {
  const errors: string[] = [];
  for (const rule of RULES) {
    const dir = path.join(ROOT, LINT_DIR, "fixtures", rule.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => SOURCE_EXT.test(f)).sort() : [];
    if (!files.some((f) => f.startsWith("bad")) || !files.some((f) => f.startsWith("ok"))) {
      errors.push(`${rule.id}: needs at least one bad*.ts and one ok*.ts fixture in ${LINT_DIR}/fixtures/${rule.id}/`);
      continue;
    }
    for (const f of files) {
      const abs = path.join(dir, f), sf = parse(abs), rel = toPosix(path.relative(ROOT, abs));
      const want = new Set(sf.text.split("\n").flatMap((l, i) => (/\/\/ lint-expect\s*$/.test(l) ? [i + 1] : [])));
      if (f.startsWith("bad") && want.size === 0) errors.push(`${rel}: a bad fixture must mark at least one line with lint-expect`);
      if (f.startsWith("ok") && want.size > 0) errors.push(`${rel}: an ok fixture must not mark any line with lint-expect`);
      const got = new Set(runRule(rule, sf, rel).map((x) => x.line));
      for (const l of want) if (!got.has(l)) errors.push(`${rel}:${l}: ${rule.id} missed a violation marked lint-expect`);
      for (const l of got) if (!want.has(l)) errors.push(`${rel}:${l}: ${rule.id} flagged a line not marked lint-expect`);
    }
  }
  // the ratchet itself: a new violation, a fixed one and a stale entry must each fail; an exact match must pass
  const exists = (f: string) => f !== "gone.ts";
  const cases: [string, Counts, Counts, boolean][] = [
    ["exact match", { r: { "a.ts": 2 } }, { r: { "a.ts": 2 } }, true],
    ["new violation", { r: { "a.ts": 3 } }, { r: { "a.ts": 2 } }, false],
    ["new file", { r: { "b.ts": 1 } }, {}, false],
    ["fixed violation", { r: { "a.ts": 1 } }, { r: { "a.ts": 2 } }, false],
    ["stale file", {}, { r: { "gone.ts": 1 } }, false],
    ["zero count", {}, { r: { "a.ts": 0 } }, false],
    ["unknown rule", {}, { x: { "a.ts": 1 } }, false],
  ];
  for (const [name, counts, base, pass] of cases) {
    if ((compareBaseline(counts, base, ["r"], exists).length === 0) !== pass) errors.push(`baseline ratchet: case "${name}" should ${pass ? "pass" : "fail"}`);
  }
  return errors;
}

const flags = process.argv.slice(2);
const unknown = flags.filter((f) => f !== "--self-test");
if (unknown.length) { console.error(`unknown argument(s): ${unknown.join(" ")}\nusage: npx tsx tools/lint/check.mts [--self-test]`); process.exit(2); }

const t0 = performance.now();
const selfErrors = selfTest();
if (selfErrors.length) { console.error(`lint self-test FAILED:\n  ${selfErrors.join("\n  ")}`); process.exit(1); }
console.log(`lint self-test passed (${RULES.length} rule(s))`);
if (flags.includes("--self-test")) process.exit(0);

const files = sourceFiles();
if (files.length === 0) { console.error(`lint: found no source files under ${SCAN_DIRS.join(", ")}`); process.exit(1); }
const findings: Finding[] = [];
for (const file of files) {
  const rules = RULES.filter((r) => r.applies(file));
  if (!rules.length) continue;
  const sf = parse(path.join(ROOT, file));
  for (const r of rules) findings.push(...runRule(r, sf, file));
}
const baseline: Counts = JSON.parse(fs.readFileSync(path.join(ROOT, LINT_DIR, "baseline.json"), "utf8"));
const mismatches = compareBaseline(tally(findings), baseline, RULES.map((r) => r.id), (rel) => fs.existsSync(path.join(ROOT, rel)));
const over = new Set(mismatches.filter((m) => m.over).map((m) => `${m.rule} ${m.file}`));
for (const f of findings) if (over.has(`${f.rule} ${f.file}`)) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.message}`);
const ms = Math.round(performance.now() - t0);
if (mismatches.length) { console.error(`\nlint FAILED (${files.length} files, ${ms} ms):\n  ${mismatches.map((m) => m.message).join("\n  ")}`); process.exit(1); }
console.log(`lint passed: ${files.length} files, ${RULES.length} rule(s), ${findings.length} baselined site(s), ${ms} ms`);
