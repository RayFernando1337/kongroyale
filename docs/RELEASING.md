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
git push origin kong-vA.B.C:refs/heads/hotfix-base/x
# CI runs only for pull requests and main. Open a draft PR from hotfix/x with base hotfix-base/x (the tag), so CI tests exactly the hotfix commit, and wait for it to go green
npx tsx tools/release.mts cut --hotfix-from kong-vA.B.C
```

A hotfix is always a patch in the base's line (`A.B`). Land the fix on `main` as well.

## Promote

After Kong Mac (Metal) and Kong RTX (D3D11) pass the `verify-kongroyale` smoke on `next` (plus a profiler A/B when the release claims perf):

```sh
npx tsx tools/release.mts promote kong-vX.Y.Z
```

This moves `stable` and clears the release's prerelease flag.

## Roll back

```sh
npx tsx tools/release.mts rollback --dry-run
npx tsx tools/release.mts rollback            # or: rollback --to kong-vA.B.C
```

`stable` moves back to the previous promoted release, the removed commits are printed, and the bad release goes back to prerelease. Attach the failing evidence to the PR that caused it, then fix forward with a patch.

## Trying it safely

`--prefix kongtest` makes the tool use `kongtest-vX.Y.Z`, `kongtest-next` and `kongtest-stable`, so a trial never touches the real tags. Delete the trial tags and releases afterwards. Every command takes `--dry-run`.
