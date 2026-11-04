// Repo lint: rules from AGENTS.md that review used to enforce by hand, checked on the TypeScript syntax tree.
// No dependency beyond the typescript package the build already uses; parse-only, so it runs in a few seconds.
//   npx tsx tools/lint/check.mts              self-test, then lint the repo against tools/lint/baseline.json
//   npx tsx tools/lint/check.mts --self-test  only the self-test
// The baseline lists the violations each file had when a rule arrived, one entry per site: the trimmed text of the
// flagged line. It only shrinks. A site that isn't listed fails, even when it replaces a fixed one; a listed site that is
// gone fails until its entry is deleted, so a fix stays fixed. Never add an entry to make a change pass; fix the code.
// The self-test runs every rule over tools/lint/fixtures/<rule>/: a line ending in "// lint-expect" must be flagged and no
// other line may be, so a rule that silently stops matching fails here before it lets a real violation through.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINT_DIR = "tools/lint";
const BASELINE = `${LINT_DIR}/baseline.json`;
const SCAN_DIRS = ["client/src", "shared", "server", "tools"];
const SOURCE_EXT = /\.(ts|mts|js|mjs)$/;

type Hit = { node: ts.Node; message: string };
type Rule = {
  id: string;
  /** which repo files the rule covers (posix path relative to the repo root) */
  applies: (rel: string) => boolean;
  check: (sf: ts.SourceFile) => Hit[];
};
/** key = the site's identity in the baseline: the trimmed text of the flagged line */
type Finding = { rule: string; file: string; line: number; key: string; message: string };
/** rule id -> file -> baselined site keys */
type Baseline = Record<string, Record<string, string[]>>;

// ---- scopes ----

/** every name a binding (a plain name or a destructuring pattern) declares */
function bindingNames(b: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(b)) out.push(b.text);
  else for (const e of b.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
  return out;
}

/** names a scope node declares for its own body; an ambient `declare const Buffer` only types the global, so it is skipped */
function scopeNames(s: ts.Node): string[] {
  const out: string[] = [];
  const statements = (list: ts.NodeArray<ts.Statement>) => {
    for (const st of list) {
      if (ts.isVariableStatement(st) && !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) for (const d of st.declarationList.declarations) bindingNames(d.name, out);
      else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) out.push(st.name.text);
      else if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        if (c.name) out.push(c.name.text);
        if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) out.push(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) out.push(e.name.text); }
      }
    }
  };
  if (ts.isSourceFile(s) || ts.isBlock(s) || ts.isModuleBlock(s)) statements(s.statements);
  else if (ts.isCaseBlock(s)) for (const c of s.clauses) statements(c.statements);
  else if (ts.isFunctionLike(s)) {
    for (const p of s.parameters) bindingNames(p.name, out);
    if ((ts.isFunctionExpression(s)) && s.name) out.push(s.name.text);
  } else if ((ts.isForStatement(s) || ts.isForInStatement(s) || ts.isForOfStatement(s)) && s.initializer && ts.isVariableDeclarationList(s.initializer)) {
    for (const d of s.initializer.declarations) bindingNames(d.name, out);
  } else if (ts.isCatchClause(s) && s.variableDeclaration) bindingNames(s.variableDeclaration.name, out);
  else if (ts.isClassExpression(s) && s.name) out.push(s.name.text);
  return out;
}

/** does a declaration in an enclosing scope (a local `screen`, a parameter `location`) hide the global of this name? */
function shadowed(n: ts.Identifier): boolean {
  for (let s: ts.Node | undefined = n.parent; s; s = s.parent) if (scopeNames(s).includes(n.text)) return true;
  return false;
}

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

/** the watched global an expression reads: an unshadowed name (`process`) or a property of an unshadowed `globalThis` */
function globalName(e: ts.Node): string | undefined {
  if (ts.isIdentifier(e)) return WATCHED.has(e.text) && isValueRef(e) && !shadowed(e) ? e.text : undefined;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "globalThis" && !shadowed(e.expression)) return e.name.text;
  return undefined;
}

// ---- shared-determinism (AGENTS.md rule 2) ----

const RULE2 = "(AGENTS.md rule 2: shared/ runs on Node and in every browser and must give the same result on both)";
const MSG_RANDOM = `Math.random() differs per run: use Rng from shared/sim/rng.ts, seeded from the match seed ${RULE2}`;
const MSG_CLOCK = `wall-clock time in shared/: drive game logic from the match tick (Match.tick, TICK_S in shared/sim/const.ts); time builds and profiles in client/ or tools/ and pass the result in ${RULE2}`;
const MSG_NODE = `Node API in shared/: move it to server/ or tools/ and pass the data in as an argument ${RULE2}`;
const MSG_IMPORT = `import() with a computed specifier in shared/ hides which module loads (usually a Node builtin kept from the bundler): load it in server/ or tools/ and pass the data in, or import a literal path ${RULE2}`;
const MSG_DOM = `browser-only API in shared/: keep it in client/src/ and pass the data in as an argument ${RULE2}`;
const NODE_GLOBALS = new Set(["process", "Buffer", "require", "__dirname", "__filename", "global", "setImmediate"]);
const DOM_GLOBALS = new Set([
  "window", "self", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "getComputedStyle", "matchMedia", "alert",
  "devicePixelRatio", "innerWidth", "innerHeight", "screen", "Image", "Audio", "AudioContext", "OffscreenCanvas",
  "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "HTMLInputElement", "WebGLRenderingContext",
  "WebGL2RenderingContext", "Worker", "WebSocket",
]);
const WATCHED = new Set(["Math", "Date", "performance", "globalThis", ...NODE_GLOBALS, ...DOM_GLOBALS]);
const isNodeModule = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec);

const sharedDeterminism: Rule = {
  id: "shared-determinism",
  applies: (rel) => rel.startsWith("shared/"),
  check(sf) {
    const hits: Hit[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const obj = globalName(n.expression), prop = n.name.text;
        if (obj === "Math" && prop === "random") hits.push({ node: n, message: MSG_RANDOM });
        if (obj === "Date" && prop === "now") hits.push({ node: n, message: MSG_CLOCK });
      }
      if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && globalName(n.expression) === "Date") hits.push({ node: n, message: MSG_CLOCK });
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isNodeModule(n.moduleSpecifier.text)) hits.push({ node: n, message: MSG_NODE });
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || globalName(n.expression) === "require") && n.arguments[0]) {
        const spec = n.arguments[0];
        if (!ts.isStringLiteralLike(spec)) hits.push({ node: n, message: MSG_IMPORT });
        else if (isNodeModule(spec.text)) hits.push({ node: n, message: MSG_NODE });
      }
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
        const g = globalName(n);
        if (g === "performance") hits.push({ node: n, message: MSG_CLOCK });
        else if (g && NODE_GLOBALS.has(g)) hits.push({ node: n, message: MSG_NODE });
        else if (g && DOM_GLOBALS.has(g)) hits.push({ node: n, message: MSG_DOM });
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
  const lines = sf.text.split(/\r?\n/);
  for (const h of rule.check(sf)) {
    const line = sf.getLineAndCharacterOfPosition(h.node.getStart(sf)).line + 1;
    if (!byLine.has(line)) byLine.set(line, { rule: rule.id, file, line, key: lines[line - 1].trim(), message: h.message });
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

/** findings the baseline doesn't list (fresh), and errors for those and for every baseline entry that no longer matches */
function compareBaseline(findings: Finding[], baseline: Baseline, ruleIds: string[], fileExists: (rel: string) => boolean): { fresh: Finding[]; errors: string[] } {
  const fresh: Finding[] = [], errors: string[] = [];
  for (const rule of Object.keys(baseline)) if (!ruleIds.includes(rule)) errors.push(`${BASELINE} names unknown rule "${rule}": remove it`);
  for (const rule of ruleIds) {
    const base = baseline[rule] ?? {};
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) if (f.rule === rule) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    for (const file of new Set([...Object.keys(base), ...byFile.keys()])) {
      const listed = base[file];
      if (listed !== undefined && (!Array.isArray(listed) || listed.length === 0 || !listed.every((k) => typeof k === "string" && k))) {
        errors.push(`${rule}: ${file} in ${BASELINE} must be a non-empty list of site texts, got ${JSON.stringify(listed)}`);
        continue;
      }
      if (listed !== undefined && !fileExists(file)) { errors.push(`${rule}: ${file} is in ${BASELINE} but does not exist: remove its entry`); continue; }
      const left = [...(listed ?? [])];
      for (const f of byFile.get(file) ?? []) {
        const i = left.indexOf(f.key);
        if (i >= 0) left.splice(i, 1);
        else { fresh.push(f); errors.push(`${rule}: ${file}:${f.line} is a new violation: fix it (see above)`); }
      }
      for (const k of left) errors.push(`${rule}: ${file} no longer has the baselined site ${JSON.stringify(k)}: delete it from ${BASELINE} so the fix stays fixed (if you only edited that line, the violation is still there: fix it)`);
    }
  }
  return { fresh, errors };
}

function selfTest(): string[] {
  const errors: string[] = [];
  for (const rule of RULES) {
    const dir = path.join(ROOT, LINT_DIR, "fixtures", rule.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => SOURCE_EXT.test(f)).sort() : [];
    if (!files.some((f) => f.startsWith("bad")) || !files.some((f) => f.startsWith("ok"))) {
      errors.push(`${rule.id}: needs at least one bad* and one ok* fixture in ${LINT_DIR}/fixtures/${rule.id}/`);
      continue;
    }
    for (const f of files) {
      const abs = path.join(dir, f), sf = parse(abs), rel = toPosix(path.relative(ROOT, abs));
      const want = new Set(sf.text.split("\n").flatMap((l, i) => (/\/\/ lint-expect\s*$/.test(l) ? [i + 1] : [])));
      if (f.startsWith("bad") && want.size === 0) errors.push(`${rel}: a bad fixture must end at least one line with // lint-expect`);
      if (f.startsWith("ok") && want.size > 0) errors.push(`${rel}: an ok fixture must not mark any line with // lint-expect`);
      const got = new Set(runRule(rule, sf, rel).map((x) => x.line));
      for (const l of want) if (!got.has(l)) errors.push(`${rel}:${l}: ${rule.id} missed a violation marked // lint-expect`);
      for (const l of got) if (!want.has(l)) errors.push(`${rel}:${l}: ${rule.id} flagged a line not marked // lint-expect`);
    }
  }
  // the ratchet itself: every way a site can appear, move or vanish must fail; only an exact match passes
  const at = (key: string, file = "a.ts"): Finding => ({ rule: "r", file, line: 1, key, message: "" });
  const exists = (f: string) => f !== "gone.ts";
  const cases: [string, Finding[], unknown, boolean][] = [
    ["exact match", [at("x"), at("x")], { r: { "a.ts": ["x", "x"] } }, true],
    ["new site", [at("x"), at("y")], { r: { "a.ts": ["x"] } }, false],
    ["new file", [at("x", "b.ts")], {}, false],
    ["one site replaces another", [at("y")], { r: { "a.ts": ["x"] } }, false],
    ["a second copy of a site", [at("x"), at("x")], { r: { "a.ts": ["x"] } }, false],
    ["fixed site", [], { r: { "a.ts": ["x"] } }, false],
    ["missing file", [], { r: { "gone.ts": ["x"] } }, false],
    ["empty list", [], { r: { "a.ts": [] } }, false],
    ["count instead of list", [at("x")], { r: { "a.ts": 1 } }, false],
    ["unknown rule", [], { q: { "a.ts": ["x"] } }, false],
  ];
  for (const [name, found, base, pass] of cases) {
    if ((compareBaseline(found, base as Baseline, ["r"], exists).errors.length === 0) !== pass) errors.push(`baseline ratchet: case "${name}" should ${pass ? "pass" : "fail"}`);
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
const baseline: Baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"));
const { fresh, errors } = compareBaseline(findings, baseline, RULES.map((r) => r.id), (rel) => fs.existsSync(path.join(ROOT, rel)));
for (const f of fresh) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.message}`);
const ms = Math.round(performance.now() - t0);
if (errors.length) { console.error(`\nlint FAILED (${files.length} files, ${ms} ms):\n  ${errors.join("\n  ")}`); process.exit(1); }
console.log(`lint passed: ${files.length} files, ${RULES.length} rule(s), ${findings.length} baselined site(s), ${ms} ms`);
