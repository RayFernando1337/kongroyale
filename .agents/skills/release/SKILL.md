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

## Flow

1. **Trains** at 10:00, 13:00, 16:00, 19:00 PT cut when `main` has unreleased merges. On demand any time. An upstream sync PR freezes trains.
2. **Hotfix:** fix forward on `main`; if `main` holds unfinished work, branch from the broken tag, cherry-pick, push, push the tag as a base branch (`git push origin <tag>:refs/heads/hotfix-base/<tag>`), open a draft PR from the hotfix branch onto it so CI tests exactly the hotfix commit, wait for green, then `cut --hotfix-from <tag>`, delete the hotfix-base branch, then land the fix on `main` too. Always a patch.
3. **Gate:** a release stays on `next` until Kong Mini (Metal, the M4 with 16 GB; Kong Mac is the fallback) and Kong RTX (D3D11) pass the `verify-kongroyale` smoke (and a profiler A/B if it claims perf). The Metal smoke must include boot, Play and a full practice match in Safari 27 on that Mac (the 16 GB Mini; if Kong Mac stands in, say how much memory it has), reporting peak WebContent memory and whether the tab was killed or survived; a kill blocks promotion. Only then `promote <tag>`. The game runs in the browser, so promotion is live as soon as the host serves `stable`.
4. **Bad release:** `rollback` first (seconds), then fix forward as the next patch with the evidence on the PR.
5. **Features ship in slices behind flags,** landing dark in several small PRs; the release that flips the default is the minor. Sim or wire changes (`NET_VERSION`, golden hashes) wait for a planned major.
6. When a fork PR gets an upstream PR, add it to `tools/release/upstream.json` so notes link it.

## Never

- Never create tags, releases or PRs on MaximilianHansen/kongroyale; the tool refuses any repo but the fork.
- Never delete or move upstream's `v0.2.0`; we only create `kong-v*`, `next` and `stable` (or `kongtest-*` in trials).
- Never test or deploy against kongroyale.com unless Ray names it as the release target.
- Never put private security issues, advisories or their fixes in release notes, PR titles that feed notes, or labels; `cut` aborts on notes that mention them.
- Never merge to make a release happen, and never apply `release:major` without Ray.
