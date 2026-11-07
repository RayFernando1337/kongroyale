---
name: release
description: "How the Kong Royale fork ships: choose release:major|minor|patch and section:* labels for a PR, cut a kong-vX.Y.Z release to next with tools/release.mts, promote it to stable after the GPU smokes, hotfix, and roll back then fix forward. Use when you cut, label, promote or roll back a release, when you open or merge a PR and must pick its release labels, or when asked about versions, trains or channels."
---

# Ship a Kong Royale fork release

The fork (rayfernando1337/kongroyale) ships small releases several times a day. The human guide is [docs/RELEASING.md](../../../docs/RELEASING.md); this is the procedure and the rules agents must not break.

## Every PR carries two labels

One bump and one section, set when the PR is opened or merged:

- Bump: `release:major` (players and servers must update together, or baked data changes: a `NET_VERSION` bump, the map contract, `island.bin`; **needs Ray's go before it is applied or merged**), `release:minor` (a player-visible feature or improvement turns on), `release:patch` (fixes, invisible perf, tooling, docs, tests; also the choice when unsure, noted in the PR).
- Section: `section:features`, `section:performance`, `section:fixes`, `section:tooling`, `section:docs`.

A release's version bump is the highest bump among its PRs. `cut` refuses unlabelled PRs.

## Commands

```sh
npx tsx tools/release.mts plan [--dry-run]                    # next version, grouped notes, unlabelled PRs
npx tsx tools/release.mts cut [--hotfix-from <tag>] [--dry-run]
npx tsx tools/release.mts promote <tag> [--dry-run]
npx tsx tools/release.mts rollback [--to <tag>] [--dry-run]
```

Always run with `--dry-run` first. Run `npm run build` and `npm test` on the commit before `cut`; it checks CI, builds and publishes a prerelease and moves `next`. Every command is safe to repeat except a bare `rollback`, which steps back one more release each time: to retry a rollback, pass `--to <known-good tag>`. Use `--prefix kongtest` for any trial; it keeps its own `kongtest-next` and `kongtest-stable` and you delete what you created.

## Is a PR ready to merge?

```sh
npx tsx tools/pr-ready.mts <number> [--repo owner/name]   # one JSON verdict; exit 0 ready, 1 not, 2 usage or gh error
```

Read-only (gh with its default login; it never merges, approves, comments, labels or pushes). `ready` is true only when every item is:

- `checks`: on the exact head, every `ci.yml` job ran and passed by name (a Devin-only green fails), every other check run passed or was neutral/skipped, and no commit status is pending or failed.
- `capy-review`: the `capy/review` status on the head says "Capy found no issues". It counts open non-note findings and updates when they are triaged; missing or failed means push an empty commit to retrigger.
- `threads`: 0 unresolved review threads.
- `mergeable`: open, not a draft, no conflicts, not BLOCKED; UNKNOWN is re-read a few times, then says to run again.
- `base`: the base is `main`.
- `size-budget-drift`: fails with "merge main first" when main and the PR both changed `tools/size-budgets.json` since their merge base.
- `labels`: exactly one `release:*` and one `section:*` label; `release:major` fails until Ray says go, then pass `--ray-go`.

## Flow

1. **Trains** at 10:00, 13:00, 16:00, 19:00 PT cut when `main` has unreleased merges. On demand any time. An upstream sync PR freezes trains.
2. **Hotfix:** fix forward on `main`; if `main` holds unfinished work, branch from the broken tag, cherry-pick, push, push the tag as a base branch (`git push origin <tag>:refs/heads/hotfix-base/<tag>`), open a draft PR from the hotfix branch onto it so CI tests exactly the hotfix commit, wait for green, then `cut --hotfix-from <tag>`, delete the hotfix-base branch, then land the fix on `main` too. Always a patch.
3. **Gate:** a release stays on `next` until Kong Mini (Metal, the M4 with 16 GB; Kong Mac is the fallback) and Kong RTX (D3D11) pass the `verify-kongroyale` smoke (and a profiler A/B if it claims perf). The Metal smoke must include boot, Play and a full practice match in Safari 27 on that Mac (the 16 GB Mini; if Kong Mac stands in, say how much memory it has), (Safari steps: the profile-kongroyale-load skill), reporting peak WebContent memory and whether the tab was killed or survived; a kill blocks promotion. Both smokes also run the flight check in [docs/RELEASING.md](../../../docs/RELEASING.md#flight-check): five interleaved `gpu-match.mts` runs a side, `next` against the last `stable`, both built from their tags in their own worktrees, at `--preset high`, where a `compare.mts` p95 frame-interval verdict of `worse` (more than 10 %) in plane, descent or ground-pan blocks promotion, plus the two plane-view screenshots side by side with a 3× crop of the island, and one more run a side with `--query "lowmem=1"` for a low-memory plane pair (missing POIs, trees or detail in either pair also block it). On Kong RTX the check takes about 25 minutes; run it from Git Bash on Windows. For a dry run before the cut, set the snippet's `cand` to the commit's SHA instead of `next` (which still points at the previous release), check the SHA it prints, and save it to check against the tag before you promote. Only then `promote <tag>`. The game runs in the browser, so promotion is live as soon as the host serves `stable`.
4. **Bad release:** `rollback` first (seconds), then fix forward as the next patch with the evidence on the PR.
5. **Features ship in slices behind flags,** landing dark in several small PRs; the release that flips the default is the minor. Sim or wire changes (`NET_VERSION`, golden hashes) wait for a planned major.
6. When a fork PR gets an upstream PR, add it to `tools/release/upstream.json` so notes link it.

## Never

- Never create tags, releases or PRs on MaximilianHansen/kongroyale; the tool refuses any repo but the fork.
- Never delete or move upstream's `v0.2.0`; we only create `kong-v*`, `next` and `stable` (or `kongtest-*` in trials).
- Never test or deploy against kongroyale.com unless Ray names it as the release target.
- Never put private security issues, advisories or their fixes in release notes, PR titles that feed notes, or labels; `cut` aborts on notes that mention them.
- Never merge to make a release happen, and never apply `release:major` without Ray.
