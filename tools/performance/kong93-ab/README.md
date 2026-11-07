# D3D11 tour A/B for the KONG-93 culprit fixes (RAY-232)

From KONG-93, at Kong Cloud's direction. One timed GPU job per fix PR: 16 tour runs (8 interleaved pairs) of about 8 minutes each, so 2 to 2.5 hours. Run it behind your release gate with nothing else on the GPU. The browser only loads the local server that gpu-match starts; nothing touches kongroyale.com.

## Job 1: PR #306 (freeze banana stand and ground loot transforms)

- base: `bc5fc3a0ac02ecc50b432d58dc04c42953c75d3d` (main merged into the PR)
- cand: `8f063a45221ce2f33ae0476b7cd3461f8dc634be` (PR #306 head, branch perf/census-matrix)

From the repo root, on branch perf/kong93-ab:

```
node tools/performance/kong93-ab/run-ab.mjs bc5fc3a0ac02ecc50b432d58dc04c42953c75d3d 8f063a45221ce2f33ae0476b7cd3461f8dc634be 8 reports/performance/kong93-ab-306
```

The script makes two worktrees beside the repo, runs `npm ci` and `npm run build` in each, interleaves `gpu-match --route tour --root <worktree>`, and writes `compare.txt`. Set `REBUILD=1` when reusing worktrees left from an earlier job.

**What I need back:** the compare.txt rows for mainThreadMs and submitMs (p50 and p95) per segment, walk-town above all. Expected: a small main-thread drop (the static cache now skips ~2.8k local matrix recomposes per frame in a town; three's matrix walk was ~7% of busy JS on the cloud profile). Upload `reports/performance/kong93-ab-306/` (gzip the JSON) to `project-kongroyale/handoffs/KONG-93/rtx-306/` and message KONG-93 with the rows.

## Job 3: hide upper bound for RAY-237 (tuk-tuks, banana stands, mango-market)

Not a fix: an upper bound on what instancing or merging those objects could save. The cand build keeps the
tuk-tuks, the banana stands and Mango Market's module roots hidden and out of the matrix walk every frame
(`?hideroots`, on by default only in the cand commit); the base build has the same code with the flag off.

- base: `d8e530a0d001f4aff7fb68c452f86208779ff5c6` (branch perf/hide-roots, main 5dbfbea + the flag)
- cand: `ae234a7528f4f14ae36e365b92a4775146005213` (branch perf/hide-roots-on, the flag on by default)

```
REBUILD=1 node tools/performance/kong93-ab/run-ab.mjs d8e530a0d001f4aff7fb68c452f86208779ff5c6 ae234a7528f4f14ae36e365b92a4775146005213 8 reports/performance/kong93-ab-hide
```

**What I need back:** the same compare.txt rows (mainThreadMs and submitMs, p50 and p95, per segment, walk-town above
all). Gate: build instancing or merging only if walk-town mainThreadMs drops by at least 1.5 ms. Upload
`reports/performance/kong93-ab-hide/` (gzip the JSON) to `project-kongroyale/handoffs/KONG-93/rtx-hide/`.
