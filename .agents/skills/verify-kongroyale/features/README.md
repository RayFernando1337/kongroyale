# Kong Royale verification map

This folder is the maintained source for verifying what a Kong Royale player can do. Read this index before driving the
game, then use the matching feature file as the recipe. Every recipe runs through `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs`.

## Baseline preconditions

- Node 22.12+ and `npm ci` in this checkout.
- An instance this run started: `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up` (client :5417, game server :3120, `KR_EVENT_MODE=0`), then `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor` with `"ok": true`.
- Never drive an instance someone else started unless you pass `--url` on purpose, and never kongroyale.com.

## Driving conventions

- Start every recipe from the title screen of a fresh page (`window.__kr.ready === true`); the helper opens one per feature.
- Act through what a player touches: `button.tn-play-cta`, the `Firing range` button, the `Friends` summary, the `Lobby code` input, keys. Read results from `window.__kr`, never set game state through it.
- Same seed, same practice match: `--seed N` (default 42).

## Proof and skip reporting

- Each feature writes `shots/verify/<run>/<feature>-*.png` and its section of `result.json`; quote the lines that prove the claim.
- `__kr.errors` must be empty. Console errors are listed in the result for triage; known warnings are in the Gotchas of SKILL.md.
- On the `nogpu` profile only `boot` and `play` run, and they prove boot and match start only. Report `range` and `room` as not run on that platform, never as passed.

## Feature entry contract

Each feature file has an H1, one paragraph on the user-visible behavior, then exactly four H2s in this order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with kr-verify`, `Gotchas`.

## Features

- [Title and boot](./title-boot.md) covers the loading screen, reaching the playable title, and the GPU in use.
- [Bot match](./bot-match.md) covers Play vs bots: warm-up, the plane, the drop, fps over the first minute.
- [Firing range](./firing-range.md) covers the practice range and that keyboard input moves the kong.
- [Private lobby](./private-lobby.md) covers create, join by code, and a two-player match on the local server.

## What a maintenance audit checks

`/maintain-verification-skill` should, per feature file: confirm the handles above still exist in `client/src/ui/lobby.ts`
and `client/src/game/index.ts` (`tn-play-cta`, `tn-play-links`, `tn-play-roomcode`, the `Friends` summary, `Lobby code`,
`__kr.game.inMatch` / `state()`), that `client/src/main.ts` still sets `__kr.ready` / `errors` / `fps`, that `vite.config.ts`
still proxies `/ws` and `/health` to `KR_PORT`, and that the verifier table in SKILL.md matches `npm run`. Then drive
`node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs all` live on at least one GPU profile and diff against the last run's `result.json`.
