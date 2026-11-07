# Spike: Quint and LemmaScript next to the TLA+ models (KONG-101)

Throwaway branch `spike/quint-lemmascript`, not for merging. Nothing here is in package.json or CI; the tools were
installed outside the repo.

## Quint port of VehicleSeats

`VehicleSeats.qnt` is a line-for-line port of tools/formal/VehicleSeats.tla: the same actions, the same four rules,
the same 3 kongs in 2 squads and 2 vehicles of 3 seats. `VehicleSeats.mutants.json` holds the same four mutants.

```sh
npm i -g @informalsystems/quint@0.33.1          # Node 18+; needs Java 17+ for the TLC and Apalache backends
node tools/formal/quint/run.mjs --backend=tlc   # exhaustive: 32,524 distinct states, same count as the TLA+ model
node tools/formal/quint/run.mjs --backend=sim   # random simulation, 20,000 traces of 20 steps, no Java
```

## LemmaScript on shared/sim/vehicle.ts

`freeSeat` carries `//@` contracts (first free seat, never a seat of another squad, result in -1..2) and verifies
with Dafny 4.11. `switchSeat`, `takeSeat`, `enterVehicle` and `exitVehicle` could not be annotated: LemmaScript
models an interface as an immutable Dafny datatype, so `p.seat = k` on a parameter does not translate.

```sh
npm i -g lemmascript@0.6.6                       # plus Dafny 4.x on PATH (self-contained zip from dafny-lang releases)
lsc check --backend=dafny shared/sim/vehicle.ts
```

The full write-up is reports/KONG-101.md in the Kong Cloud captain drive.
