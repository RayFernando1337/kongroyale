# Releasing the fork

This is for the fork (rayfernando1337/kongroyale) only. We never publish tags or releases on MaximilianHansen/kongroyale. The design and its reasons are in the release process plan; this page is the how-to.

A release is a `kong-vX.Y.Z` tag on `main`, a GitHub Release with grouped notes, and the built `dist/` attached as a tarball. Two moving tags track it: `next` (the newest release) and `stable` (the newest release that passed the GPU smokes). The game runs in the browser, so whatever host serves `stable` goes live the moment `stable` moves.

## Label every PR

Each PR that merges to `main` needs one bump label and one section label:

| Label | Use |
|---|---|
| `release:major` | Players or servers must update together, or baked data changes (`NET_VERSION`, the map contract, `island.bin`, a save format). Needs Ray's go. |
| `release:minor` | A player-visible feature turns on, or the release's headline is a player-visible improvement. |
| `release:patch` | Fixes, perf with no visible change, tooling, docs, tests. Anything unclear. |
| `section:features`, `section:performance`, `section:fixes`, `section:tooling`, `section:docs` | Where the PR's line goes in the notes. |

A release's bump is the highest bump among its PRs. `cut` refuses to run while a PR in the release lacks either label.

## Cut

```sh
git checkout main && git pull
npm run build && npm test
npx tsx tools/release.mts plan             # next version, grouped notes, unlabelled PRs
npx tsx tools/release.mts cut --dry-run
npx tsx tools/release.mts cut
```

`cut` requires green CI on the release commit, a clean tree on the tip of `main`, and notes with no forbidden words. It builds, publishes the release as a prerelease with the tarball, and moves `next`. Running it again on a released commit does nothing. Each note line gives the PR, its title and the upstream PR from `tools/release/upstream.json` (add an entry when a fork PR gets an upstream PR; unmapped PRs show as "fork only").

Trains run at 10:00, 13:00, 16:00 and 19:00 PT and skip when nothing new has merged. An upstream sync PR freezes trains.

## Hotfix

Fix forward on `main` and cut as usual when `main` holds nothing unreleased. Otherwise branch from the broken tag, cherry-pick the fix, push the branch, then:

```sh
git checkout -b hotfix/x kong-vA.B.C && git cherry-pick <fix> && git push -u origin HEAD
git push origin kong-vA.B.C:refs/heads/hotfix-base/kong-vA.B.C
# CI runs only for pull requests and main. Open a draft PR from hotfix/x with base hotfix-base/kong-vA.B.C (the tag), so CI tests exactly the hotfix commit, and wait for it to go green
npx tsx tools/release.mts cut --hotfix-from kong-vA.B.C
```

A hotfix is always a patch in the base's line (`A.B`). Delete the `hotfix-base/*` branch, and land the fix on `main` as well.

## Promote

After Kong Mini (the M4 with 16 GB; Kong Mac is the fallback) and Kong RTX (D3D11) pass the `verify-kongroyale` smoke on `next`, plus a profiler A/B when the release claims perf. The Metal smoke must include boot, Play and a full practice match in Safari 27 on that Mac (the 16 GB Mini; if Kong Mac stands in, say how much memory it has), (the Safari steps are in the profile-kongroyale-load skill) and report the peak WebContent memory and whether the tab was killed or survived. A kill blocks promotion. Both smokes also run the [flight check](#flight-check).

```sh
npx tsx tools/release.mts promote kong-vX.Y.Z
```

This moves `stable` and clears the release's prerelease flag.

## Flight check

Part of both GPU smokes: Kong Mini (Metal) and Kong RTX (D3D11). Ray reported a release that felt laggy and read badly from the plane, and every gate before this one passed it (RAY-135). This check compares `next` with the last `stable` on frame time in flight and on the plane view.

1. Build both sides from their tags, each in its own worktree. `main` may have moved past the release since the cut, so never build the candidate from your checkout. Before you promote, check that the measured `next` commit is still the release tag's commit.
2. Run `tools/performance/gpu-match.mts` five times a side, interleaved, at a fixed preset, one GPU job at a time. A run takes about 7 minutes, so plan on about 70 minutes per machine.
3. Compare the p95 frame interval. A `worse` row in `gpu/match/plane`, `gpu/match/descent` or `gpu/match/ground-pan` blocks promotion. That means the medians differ by more than 10 % and every `next` run falls outside the `stable` range. The `warmup-15s` row is for information only. `compare.mts` exits nonzero on any `worse` row, warm-up included, and on a failed run gate (a window under 5 s, low GPU-timer coverage), a lost metric or an invalid row. A nonzero exit blocks promotion unless its only cause is a `worse` warm-up row: check the table, also saved with `--out`.
4. Put the first `stable` and `next` plane screenshots (`*-plane.png`, 8 s into the plane) side by side in the smoke report. A plane view with visibly missing POIs, trees or detail also blocks promotion.

```sh
git fetch --tags --force origin
git worktree add --detach ../kr-stable stable && (cd ../kr-stable && npm ci && npm run build)
git worktree add --detach ../kr-next next && (cd ../kr-next && npm ci && npm run build && git rev-parse HEAD)
for i in 1 2 3 4 5; do
  npx tsx tools/performance/gpu-match.mts --root ../kr-stable --preset high --shots shots/flight --out reports/flight/stable-$i.json
  npx tsx tools/performance/gpu-match.mts --root ../kr-next --preset high --shots shots/flight --out reports/flight/next-$i.json
done
npx tsx tools/performance/compare.mts --base reports/flight/stable-*.json --cand reports/flight/next-*.json --metrics frameIntervalMs --stats p95 --threshold 10 --out reports/flight/compare.json
```

`gpu-match.mts` drives Chrome only. On the Metal smoke, also open the Safari survival match with `?seed=42&perfhud`, press F8 8 s into the plane for the plane screenshot, and press F8 again after 15 s on the ground. Report the per-phase frame p95 (plane, descent, the first 15 s on the ground) from the second bundle, beside `stable`'s; a bundle only holds the timeline up to the moment F8 was pressed. The Safari numbers are for information until Safari has a repeatable five-run tool. A software renderer fails `gpu-match.mts`, so the cloud machines can't run this check.

## Roll back

```sh
npx tsx tools/release.mts rollback --dry-run
npx tsx tools/release.mts rollback            # or: rollback --to kong-vA.B.C
```

`stable` moves back to the previous promoted release, the removed commits are printed, and the bad release goes back to prerelease. Attach the failing evidence to the PR that caused it, then fix forward with a patch.

## Trying it safely

`--prefix kongtest` makes the tool use `kongtest-vX.Y.Z`, `kongtest-next` and `kongtest-stable`, so a trial never touches the real tags. Delete the trial tags and releases afterwards. Every command takes `--dry-run`.
