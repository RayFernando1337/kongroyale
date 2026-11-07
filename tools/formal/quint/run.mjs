// Spike runner for the Quint port of VehicleSeats (KONG-101): checks the model, then each mutant must break the rule it
// names. Usage: node tools/formal/quint/run.mjs [--backend=tlc|sim] [--quint=path]. Not wired into npm test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => (process.argv.find((a) => a.startsWith("--" + name + "=")) ?? "").split("=")[1] || dflt;
const quint = arg("quint", "quint");
const backend = arg("backend", "tlc");
const rules = ["seatsAgree", "noDeadRider", "oneSquad", "rideOnWheels"];

function check(file, invariants) {
  const args = backend === "sim"
    ? ["run", file, "--invariants", ...invariants, "--max-samples=20000", "--max-steps=20", "--seed=1"]
    : ["verify", file, "--backend=tlc", "--invariants", ...invariants];
  const t0 = performance.now();
  try {
    const out = execFileSync(quint, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out, s: (performance.now() - t0) / 1000 };
  } catch (e) {
    return { ok: false, out: String(e.stdout) + String(e.stderr), s: (performance.now() - t0) / 1000 };
  }
}

const src = readFileSync(join(here, "VehicleSeats.qnt"), "utf8");
let failed = 0;
const base = check(join(here, "VehicleSeats.qnt"), rules);
console.log((base.ok ? "PASS" : "FAIL") + " VehicleSeats (" + backend + ", " + base.s.toFixed(1) + " s)");
if (!base.ok) { failed++; console.log(base.out); }

for (const m of JSON.parse(readFileSync(join(here, "VehicleSeats.mutants.json"), "utf8"))) {
  if (!src.includes(m.find)) { failed++; console.log("FAIL mutant \"" + m.name + "\": find text not in the model"); continue; }
  const dir = mkdtempSync(join(tmpdir(), "quint-mutant-"));
  const file = join(dir, "VehicleSeats.qnt");
  writeFileSync(file, src.replace(m.find, m.replace));
  const r = check(file, [m.expect]);
  const caught = !r.ok && /violat/i.test(r.out);
  console.log((caught ? "PASS" : "FAIL") + " mutant \"" + m.name + "\": " + (caught ? m.expect + " violated" : "not caught") + " (" + r.s.toFixed(1) + " s)");
  if (!caught) { failed++; console.log(r.out.slice(-2000)); }
}
process.exit(failed ? 1 : 0);
