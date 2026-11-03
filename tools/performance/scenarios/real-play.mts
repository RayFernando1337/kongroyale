// The representative seeded host workload for FND comparisons (PERFORMANCE.md §1): a full trios lobby of bots on the
// real island, from START through the plane, the drop, looting and the first fights. Nothing is placed or scripted:
// bots do what they do in a real match, so the cost includes pathing, loot search, aiming and hit tests.
// host.mts runs it as --scenario real-play. Bump version whenever the workload below changes.
export const REAL_PLAY = {
  id: "host/real-play",
  version: 1,
  /** the same seed as `npm run sim`, so a slow tick here can be replayed with the headless sim */
  seed: 42,
  workload: "real-play",
  /** timed from the first PLAY tick: 120 s covers the drop, landing, looting and the first fights */
  measuredTicks: 7200,
} as const;
