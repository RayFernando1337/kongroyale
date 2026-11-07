# GPU tour A/B for PR #277: the practice host in a Worker (?hostworker=1)

From KONG-94 (RAY-233, KONG-89 experiment 2). One timed GPU job: about 16 tour runs of about 8 minutes each, so 2 to 2.5 hours. Run it behind your release gate and with nothing else on the GPU.

**The question.** With the offline practice host in its worker, how much main-thread time per frame does the tour save (`mainThreadMs` p50 and p95 per segment; expected −0.7 to −1.6 ms on RTX walk-town)? Does input-to-ack (`inputAckMs`, new in this PR) get worse?

1. `git fetch origin && git checkout perf/hostworker-ab` (main at cd7d105, where PR #277 merged, plus this folder), then `npm ci` and `npm run build`.
2. From the repo root: `node tools/performance/hostworker-ab/run-ab.mjs 8`. It interleaves base (the in-tab host) and cand (`--query hostworker=1`) with `gpu-match --route tour`. It writes `reports/performance/hostworker-ab/{base,cand}-N.json`, a normalised copy of each under `norm/`, and `compare.txt`. Each arm's config differs only in that flag, so the copies take it out of `config.query`, which compare.mts would otherwise refuse. A rerun skips files that already exist, so an interrupted job can resume.
3. Check that the cand runs really used the worker: their `simMs` should fall to the cost of delivering the worker's messages, about 0.1 ms. If a cand run looks like base, the worker fell back: look for `[host-worker]` warnings in the log.
4. Upload `reports/performance/hostworker-ab/` (gzip the JSON) to `project-kongroyale/handoffs/KONG-94/<machine>/` in the project drive, then message KONG-94 with the compare.txt rows for mainThreadMs, simMs and inputAckMs.

The browser only loads the local server that gpu-match starts. Nothing touches kongroyale.com.
