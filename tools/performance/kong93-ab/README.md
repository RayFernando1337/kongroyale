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
