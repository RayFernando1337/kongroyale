import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GateError, nonEmpty, oneOf, parseFlags } from "./gate.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = { "--json": "bool", "--port": "number", "--mode": "string", "--base": "list" } as const;
const rejects = (argv: string[], match: RegExp) => assert.throws(() => parseFlags(argv, spec), (e: unknown) => e instanceof GateError && match.test(e.message), argv.join(" "));

assert.deepEqual(parseFlags(["--json", "--port", "3027", "--mode=solo", "--base", "a.json", "b.json"], spec).flags, { "--json": true, "--port": 3027, "--mode": "solo", "--base": ["a.json", "b.json"] });
assert.deepEqual(parseFlags([], spec).flags, {});
rejects(["--jsn"], /unknown flag --jsn/);
rejects(["--port"], /--port needs a value/);
rejects(["--port", "--json"], /--port needs a value/);
rejects(["--port", "abc"], /finite number/);
rejects(["--port", "Infinity"], /finite number/);
rejects(["--port="], /needs a value/);
rejects(["--base"], /--base needs a value/);
rejects(["--json=1"], /takes no value/);
rejects(["--port", "1", "--port", "2"], /given twice/);
rejects(["stray"], /unexpected argument/);
assert.deepEqual(parseFlags(["a", "--json"], spec, { positional: true }).positional, ["a"]);
assert.throws(() => nonEmpty([], "result files"), /found no result files/);
assert.deepEqual(nonEmpty([1], "x"), [1]);
assert.throws(() => oneOf("squads", ["trios", "solo"] as const, "--mode"), /--mode must be one of trios, solo/);

const cases: [string, string[], RegExp][] = [
  ["tools/performance/compare.mts", ["--bse", "a.json"], /unknown flag --bse/],
  ["tools/performance/compare.mts", ["--base"], /--base needs a value/],
  ["tools/performance/compare.mts", ["--base", "a.json", "--threshold", "five"], /finite number/],
  ["tools/performance/compare.mts", [], /pass at least one --base/],
  ["tools/verify-assets.mts", ["--jsn"], /unknown flag --jsn/],
  ["tools/verify-boot.mts", ["--prot", "3027"], /unknown flag --prot/],
  ["tools/verify-boot.mts", ["--mode", "squads"], /--mode must be one of/],
  ["tools/verify-boot.mts", ["--match", "lots"], /finite number/],
];
for (const [file, args, match] of cases) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(root, file), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 2, `${file} ${args.join(" ")} should exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, match, `${file} ${args.join(" ")}`);
}
console.log(`gate helpers: ${cases.length} verifier invocations refused bad input`);
