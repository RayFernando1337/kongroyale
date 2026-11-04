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

type Hit = { node: ts.Node; message: string; line?: number };
type Rule = {
  id: string;
  /** which repo files the rule covers (posix path relative to the repo root) */
  applies: (rel: string) => boolean;
  check: (sf: ts.SourceFile, rel: string) => Hit[];
  counted?: boolean;
  report?: boolean;
};
/** key = the site's identity in the baseline: the trimmed text of the flagged line */
type Finding = { rule: string; file: string; line: number; key: string; message: string };
/** rule id -> file -> baselined site keys */
type Baseline = Record<string, Record<string, string[] | number>>;

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

const HOT_JSON = `${LINT_DIR}/hot.json`, HOT_FIXTURE_JSON = `${LINT_DIR}/fixtures/hot-alloc/hot.json`;
const HOT: Record<string, string[]> = Object.assign({}, ...[HOT_JSON, HOT_FIXTURE_JSON].map((p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"))));
const isHotFile = (rel: string) => rel.endsWith(".hot.ts");
const ALLOC_METHODS = new Set(["map", "filter", "flatMap", "flat", "slice", "concat", "splice", "toSorted", "toReversed", "toSpliced"]);
const HOT_RULE = `(AGENTS.md rule 2: per-tick code lives in *.hot.ts files and must not allocate; ${HOT_JSON} lists the hot functions not yet moved into one)`;

function functionOf(e: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : undefined;
}

function topLevelFunctions(sf: ts.SourceFile): [string, ts.FunctionLikeDeclaration][] {
  const out: [string, ts.FunctionLikeDeclaration][] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) out.push([st.name?.text ?? "default", st]);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const fn = functionOf(d.initializer);
        if (fn && ts.isIdentifier(d.name)) out.push([d.name.text, fn]);
      }
    }
    if (ts.isExportAssignment(st)) {
      const fn = functionOf(st.expression);
      if (fn) out.push(["default", fn]);
    }
    if (ts.isClassDeclaration(st)) {
      for (const m of st.members) {
        const owner = `${st.name?.text ?? "default"}.${m.name?.getText(sf)}`;
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body) out.push([owner, m]);
        const field = ts.isPropertyDeclaration(m) ? functionOf(m.initializer) : undefined;
        if (field) out.push([owner, field]);
      }
    }
  }
  return out;
}

const findHot = (sf: ts.SourceFile, name: string) => topLevelFunctions(sf).find(([n]) => n === name)?.[1];

function hotFileFunctions(sf: ts.SourceFile): [string, ts.FunctionLikeDeclaration][] {
  const out: [string, ts.FunctionLikeDeclaration][] = [];
  const label = (fn: ts.FunctionLikeDeclaration): string => {
    const p = fn.parent;
    const own = fn.name ?? ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) ? p.name : undefined);
    const owner = ts.isClassLike(p) ? p : ts.isPropertyDeclaration(p) && ts.isClassLike(p.parent) ? p.parent : undefined;
    if (!own) return `the function at line ${sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1}`;
    return owner ? `${owner.name?.text ?? "class"}.${own.getText(sf)}` : own.getText(sf);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isConstructorDeclaration(n)) { n.parameters.forEach(visit); if (n.body) ts.forEachChild(n.body, visit); return; }
    if (ts.isFunctionLike(n) && "body" in n && n.body) { out.push([label(n as ts.FunctionLikeDeclaration), n as ts.FunctionLikeDeclaration]); return; }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

function allocation(n: ts.Node, sf: ts.SourceFile): string | undefined {
  if (ts.isNewExpression(n)) return `new ${n.expression.getText(sf)} allocates: create it once (module scope or a field) and reuse it`;
  if (ts.isObjectLiteralExpression(n)) return "an object literal allocates: reuse a preallocated scratch object (like the module-level H = makeHit() in shared/sim/loot-spots.ts)";
  if (ts.isArrayLiteralExpression(n)) return "an array literal allocates: reuse a preallocated array or typed array";
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return "a closure allocates: hoist the function to module scope or a method, and loop with an indexed for";
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ALLOC_METHODS.has(n.expression.name.text)) return `.${n.expression.name.text}() returns a new array: loop with an indexed for over the original`;
  if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) return "a spread copies into a new array or object: copy the fields into a reused one";
  if ((ts.isBindingElement(n) || ts.isParameter(n)) && n.dotDotDotToken) return "a rest binding copies into a new array or object: read the fields or indices you need";
  return undefined;
}

const hotAlloc: Rule = {
  id: "hot-alloc",
  applies: (rel) => rel in HOT || isHotFile(rel),
  check(sf, rel) {
    const hits: Hit[] = [];
    const hot = isHotFile(rel) ? hotFileFunctions(sf) : (HOT[rel] ?? []).flatMap((name): [string, ts.FunctionLikeDeclaration][] => {
      const fn = findHot(sf, name);
      return fn ? [[name, fn]] : [];
    });
    for (const [name, fn] of hot) {
      const visit = (n: ts.Node): void => {
        const what = allocation(n, sf);
        if (what) hits.push({ node: n, message: `${name} is a hot function and ${what} ${HOT_RULE}` });
        ts.forEachChild(n, visit);
      };
      fn.parameters.forEach(visit);
      if (fn.body && ts.isBlock(fn.body)) ts.forEachChild(fn.body, visit);
      else if (fn.body) visit(fn.body);
    }
    return hits;
  },
};

function hotListErrors(list: unknown, from: string, readable: (rel: string) => ts.SourceFile | undefined): string[] {
  if (!list || typeof list !== "object" || Array.isArray(list)) return [`${from} must be an object of file -> function names`];
  const errors: string[] = [];
  for (const [file, names] of Object.entries(list)) {
    if (!Array.isArray(names) || names.length === 0 || !names.every((x) => typeof x === "string" && x)) { errors.push(`${from}: ${file} must list at least one function name`); continue; }
    if (isHotFile(file)) { errors.push(`${from}: ${file} is a *.hot.ts file, so every function in it is already hot: remove its entry`); continue; }
    const sf = readable(file);
    if (!sf) { errors.push(`${from}: ${file} is not a source file the lint scans (under ${SCAN_DIRS.join(", ")}, outside the fixtures): fix the path or remove the entry`); continue; }
    for (const name of names) if (!findHot(sf, name)) errors.push(`${from}: ${file} has no function ${name} (a top-level function, a const arrow, or Class.method): fix the name or remove it`);
  }
  return errors;
}

const LINE_DIRECTIVES = ["@ts-expect-error", "@ts-ignore", "@ts-nocheck"], BLOCK_DIRECTIVES = ["@vite-ignore"];
const MSG_COMMENT = "no comments (plan decision 2, after Lauren Tan): say it with a name, a type or a test instead; the pstack no-comments skill turns one comment at a time into one of those. Tool directives (@ts-expect-error, @vite-ignore, /// <reference>) are allowed";

function isDirective(text: string): boolean {
  if (text.startsWith("/// <reference")) return true;
  const line = text.startsWith("//");
  const word = (line ? text.slice(2) : text.slice(2, -2)).trim().split(/\s/, 1)[0];
  return (line ? LINE_DIRECTIVES : BLOCK_DIRECTIVES).includes(word);
}

function comments(sf: ts.SourceFile): ts.CommentRange[] {
  const seen = new Map<number, ts.CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined) => { for (const r of ranges ?? []) seen.set(r.pos, r); };
  const walk = (n: ts.Node): void => {
    if (ts.isJSDoc(n)) return;
    if (n.kind < ts.SyntaxKind.FirstNode) { add(ts.getLeadingCommentRanges(sf.text, n.pos)); add(ts.getTrailingCommentRanges(sf.text, n.end)); }
    n.getChildren(sf).forEach(walk);
  };
  walk(sf);
  return [...seen.values()];
}

const noComments: Rule = {
  id: "no-comments",
  counted: true,
  applies: () => true,
  check(sf, rel) {
    const hits: Hit[] = [];
    for (const c of comments(sf)) {
      const text = sf.text.slice(c.pos, c.end);
      if (isDirective(text) || (rel.startsWith(`${LINT_DIR}/fixtures/`) && text === "// lint-expect")) continue;
      const first = sf.getLineAndCharacterOfPosition(c.pos).line, last = sf.getLineAndCharacterOfPosition(c.end).line;
      for (let l = first; l <= last; l++) hits.push({ node: sf, line: l + 1, message: MSG_COMMENT });
    }
    return hits;
  },
};

function inTypePosition(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isHeritageClause(p)) return p.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent);
    if (ts.isExpressionWithTypeArguments(p)) continue;
    if (ts.isTypeNode(p)) return true;
    if (ts.isExportSpecifier(p)) return p.isTypeOnly || p.parent.parent.isTypeOnly;
    if (ts.isExpression(p) || ts.isStatement(p) || ts.isShorthandPropertyAssignment(p)) return false;
  }
  return false;
}

const importType: Rule = {
  id: "import-type",
  applies: (rel) => /\.m?ts$/.test(rel),
  check(parsed) {
    const program = ts.createProgram({ rootNames: [parsed.fileName], options: { noResolve: true, noLib: true, types: [], noEmit: true } });
    const sf = program.getSourceFile(parsed.fileName)!, checker = program.getTypeChecker();
    const imports = new Map<ts.Symbol, { id: ts.Identifier; value: boolean; type: boolean }>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
      const c = st.importClause, names: ts.Identifier[] = [];
      if (c.name) names.push(c.name);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) names.push(e.name);
      for (const id of names) {
        const sym = checker.getSymbolAtLocation(id);
        if (sym) imports.set(sym, { id, value: false, type: false });
      }
    }
    const symbolOf = (n: ts.Identifier): ts.Symbol | undefined => {
      const p = n.parent;
      if (ts.isShorthandPropertyAssignment(p) && p.name === n) return checker.getShorthandAssignmentValueSymbol(p);
      if (ts.isExportSpecifier(p)) return (p.propertyName ?? p.name) === n ? checker.getExportSpecifierLocalTargetSymbol(p) : undefined;
      return checker.getSymbolAtLocation(n);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n)) {
        const sym = symbolOf(n), u = sym && imports.get(sym);
        if (u) { if (inTypePosition(n)) u.type = true; else u.value = true; }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const hits: Hit[] = [];
    for (const { id, value, type } of imports.values()) {
      const line = sf.getLineAndCharacterOfPosition(id.getStart(sf)).line + 1;
      if (!value && !type) hits.push({ node: id, line, message: `${id.text} is imported but never used: delete it` });
      else if (!value) hits.push({ node: id, line, message: `${id.text} is only used as a type: import it with \`import type\` so the bundler never loads its module for it (AGENTS.md "Code style")` });
    }
    return hits;
  },
};

const UNIT_SUFFIXES = ["S", "MS", "M", "R", "MPS", "DEG", "RAD", "HZ", "PX", "TICKS", "N", "PCT", "KB", "MB", "BYTES"];

function isNumeric(e: ts.Expression): boolean {
  if (ts.isNumericLiteral(e)) return true;
  if (ts.isParenthesizedExpression(e)) return isNumeric(e.expression);
  if (ts.isPrefixUnaryExpression(e)) return isNumeric(e.operand);
  if (ts.isBinaryExpression(e)) return isNumeric(e.left) && isNumeric(e.right);
  return false;
}

const unitSuffix: Rule = {
  id: "unit-suffix",
  report: true,
  applies: (rel) => /\.m?ts$/.test(rel),
  check(sf) {
    const hits: Hit[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z][A-Z0-9_]*$/.test(n.name.text) && n.initializer && isNumeric(n.initializer)
        && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const && !UNIT_SUFFIXES.includes(n.name.text.split("_").pop() ?? "")) {
        hits.push({ node: n, message: `${n.name.text} is a number without a unit suffix (${UNIT_SUFFIXES.map((s) => "_" + s).join(", ")}): name its unit, like WARMUP_S or NEAR_R (AGENTS.md "Code style"; report only for now)` });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  },
};

const RULES: Rule[] = [sharedDeterminism, hotAlloc, noComments, importType, unitSuffix];

// ---- engine ----

const toPosix = (p: string) => p.split(path.sep).join("/");
const parse = (abs: string) => ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const readSource = (rel: string) => (fs.existsSync(path.join(ROOT, rel)) ? parse(path.join(ROOT, rel)) : undefined);

/** one finding per rule and line: two hits on one line are one site to fix */
function runRule(rule: Rule, sf: ts.SourceFile, file: string): Finding[] {
  const byLine = new Map<number, Finding>();
  const lines = sf.text.split(/\r?\n/);
  for (const h of rule.check(sf, file)) {
    const line = h.line ?? sf.getLineAndCharacterOfPosition(h.node.getStart(sf)).line + 1;
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
function compareBaseline(findings: Finding[], baseline: Baseline, rules: Pick<Rule, "id" | "counted">[], fileExists: (rel: string) => boolean): { fresh: Finding[]; errors: string[] } {
  const fresh: Finding[] = [], errors: string[] = [];
  for (const rule of Object.keys(baseline)) if (!rules.some((r) => r.id === rule)) errors.push(`${BASELINE} names unknown rule "${rule}": remove it`);
  for (const { id: rule, counted } of rules) {
    const base = baseline[rule] ?? {};
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) if (f.rule === rule) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    for (const file of new Set([...Object.keys(base), ...byFile.keys()])) {
      const listed = base[file], found = byFile.get(file) ?? [];
      if (counted) {
        if (listed !== undefined && (typeof listed !== "number" || !Number.isInteger(listed) || listed < 1)) { errors.push(`${rule}: ${file} in ${BASELINE} must be a positive line count, got ${JSON.stringify(listed)}`); continue; }
        if (listed !== undefined && !fileExists(file)) { errors.push(`${rule}: ${file} is in ${BASELINE} but does not exist: remove its entry`); continue; }
        const allowed = listed ?? 0, n = found.length;
        if (n > allowed && allowed === 0) fresh.push(...found);
        if (n > allowed) errors.push(`${rule}: ${file} has ${n} flagged line(s), the baseline allows ${allowed}: remove the new one(s)${allowed ? " (git diff shows yours)" : ` (see above), or, if this code moved here from another file, move that file's count to this entry in ${BASELINE}: a move may transfer counts, but the total must not grow`}`);
        if (n < allowed) errors.push(`${rule}: ${file} has ${n} flagged line(s), fewer than the baseline's ${allowed}: ${n ? `lower its count in ${BASELINE} to ${n}` : `delete its entry from ${BASELINE}`} so it stays that way`);
        continue;
      }
      if (listed !== undefined && (!Array.isArray(listed) || listed.length === 0 || !listed.every((k) => typeof k === "string" && k))) {
        errors.push(`${rule}: ${file} in ${BASELINE} must be a non-empty list of site texts, got ${JSON.stringify(listed)}`);
        continue;
      }
      if (listed !== undefined && !fileExists(file)) { errors.push(`${rule}: ${file} is in ${BASELINE} but does not exist: remove its entry`); continue; }
      const left = [...(listed ?? [])];
      for (const f of found) {
        const i = left.indexOf(f.key);
        if (i >= 0) left.splice(i, 1);
        else { fresh.push(f); errors.push(`${rule}: ${file}:${f.line} is a new violation: fix it (see above), or, if the line moved here unchanged from another file, move its entry in ${BASELINE} with it`); }
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
  const atC = (file = "a.ts"): Finding => ({ rule: "c", file, line: 1, key: "", message: "" });
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
    ["counted: exact count", [atC(), atC()], { c: { "a.ts": 2 } }, true],
    ["counted: one more", [atC(), atC(), atC()], { c: { "a.ts": 2 } }, false],
    ["counted: new file", [atC("b.ts")], {}, false],
    ["counted: one fewer", [atC()], { c: { "a.ts": 2 } }, false],
    ["counted: all gone", [], { c: { "a.ts": 2 } }, false],
    ["counted: list instead of count", [atC()], { c: { "a.ts": ["x"] } }, false],
    ["counted: zero", [], { c: { "a.ts": 0 } }, false],
    ["counted: missing file", [], { c: { "gone.ts": 1 } }, false],
  ];
  for (const [name, found, base, pass] of cases) {
    if ((compareBaseline(found, base as Baseline, [{ id: "r" }, { id: "c", counted: true }], exists).errors.length === 0) !== pass) errors.push(`baseline ratchet: case "${name}" should ${pass ? "pass" : "fail"}`);
  }
  errors.push(...hotListErrors(readJson(HOT_FIXTURE_JSON), HOT_FIXTURE_JSON, readSource));
  const hotSf = ts.createSourceFile("h.ts", "export function f() {}\nexport const g = () => 0;\nexport class C { m() {} }\n", ts.ScriptTarget.Latest, true);
  const hotCases: [string, unknown, boolean][] = [
    ["every kind of name", { "h.ts": ["f", "g", "C.m"] }, true],
    ["missing function", { "h.ts": ["f", "stepPlayr"] }, false],
    ["missing method", { "h.ts": ["C.tick"] }, false],
    ["missing file", { "gone.ts": ["f"] }, false],
    ["empty list", { "h.ts": [] }, false],
    ["not an object", ["h.ts"], false],
    ["a *.hot.ts file", { "x.hot.ts": ["f"] }, false],
  ];
  for (const [name, list, pass] of hotCases) {
    if ((hotListErrors(list, "hot.json", (rel) => (rel === "h.ts" ? hotSf : undefined)).length === 0) !== pass) errors.push(`hot list: case "${name}" should ${pass ? "pass" : "fail"}`);
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
const hotErrors = hotListErrors(readJson(HOT_JSON), HOT_JSON, (rel) => (files.includes(rel) ? readSource(rel) : undefined));
if (hotErrors.length) { console.error(`lint FAILED:\n  ${hotErrors.join("\n  ")}`); process.exit(1); }
const findings: Finding[] = [];
for (const file of files) {
  const rules = RULES.filter((r) => r.applies(file));
  if (!rules.length) continue;
  const sf = parse(path.join(ROOT, file));
  for (const r of rules) findings.push(...runRule(r, sf, file));
}
const baseline: Baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"));
const gated = RULES.filter((r) => !r.report);
const { fresh, errors } = compareBaseline(findings.filter((f) => gated.some((r) => r.id === f.rule)), baseline, gated, (rel) => fs.existsSync(path.join(ROOT, rel)));
for (const r of RULES.filter((r) => r.report)) {
  const mine = findings.filter((f) => f.rule === r.id);
  console.log(`${r.id} (report only, never fails): ${mine.length} site(s) in ${new Set(mine.map((f) => f.file)).size} file(s)`);
}
for (const f of fresh) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.message}`);
const ms = Math.round(performance.now() - t0);
if (errors.length) { console.error(`\nlint FAILED (${files.length} files, ${ms} ms):\n  ${errors.join("\n  ")}`); process.exit(1); }
console.log(`lint passed: ${files.length} files, ${gated.length} gating rule(s), ${findings.length - findings.filter((f) => !gated.some((r) => r.id === f.rule)).length} baselined site(s), ${ms} ms`);
