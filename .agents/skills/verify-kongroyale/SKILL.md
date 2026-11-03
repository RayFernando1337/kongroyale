---
name: verify-kongroyale
description: "Drive Kong Royale in a real browser the way a player does (title, Play vs bots, Firing range, a two-player private lobby on a local server) and capture proof that a change works, on macOS (Metal), Windows (D3D11) or a no-GPU Linux cloud machine (SwiftShader, boot and smoke only). Use before calling any player-visible change, client, server, or shared/ change done, or when asked to play-test, smoke-test, or check for regressions."
---

# Verify Kong Royale

Kong Royale is a browser game: a Vite dev client (three.js) talking over WebSockets to a Node game server, both running
the simulation in `shared/`. A player opens the page, waits for the title, then presses **Play** (a bot match run in the
browser), opens **Firing range**, or creates a private lobby that a friend joins by code. This skill does exactly that
through Playwright and writes screenshots plus a `result.json` you can attach to a pull request. AGENTS.md "Check it in
the game" is the human version of the same flow.

Everything runs through one helper, run from the repository root (Node 22.12+; it uses the repo's own Playwright):

```sh
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up        # start an isolated client on :5417 and game server on :3120 (KR_EVENT_MODE=0)
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor    # read-only: node, ports, /health, title reaches __kr.ready, GPU string matches the platform
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs all       # drive every feature in features/ (nogpu: boot + play only); or one of: boot | play | range | room
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs down      # stop what up started; evidence stays in shots/verify/
```

## Platforms

The helper picks a profile from the OS; override with `--profile`. A run on the wrong renderer proves nothing about
looks or frame rate, so doctor fails when the GPU string does not match the profile.

| Profile | Where | Browser | Renderer doctor expects | What it can prove |
|---|---|---|---|---|
| `mac` | macOS, Apple silicon | Google Chrome (`--channel chrome`), headless, `--use-angle=metal` | `ANGLE Metal Renderer` | everything, including fps and visuals |
| `win` | Windows, discrete or integrated GPU | Google Chrome, headless, `--use-angle=d3d11` | `Direct3D11` / `D3D11`, not SwiftShader or "Basic Render" | everything, including fps and visuals |
| `nogpu` | Linux cloud machine with no GPU | Playwright's bundled Chromium, `--use-angle=swiftshader --enable-unsafe-swiftshader` | anything (SwiftShader) | boot reaches ready with no errors; a bot match starts. Not fps, not visuals |

Validated end to end: `mac` (M3 Max), `nogpu`, and `win` on a Windows on ARM64 laptop (NVIDIA RTX Spark N1X, driver
617.42, Node 24.20 arm64, Chrome 156 arm64; renderer `ANGLE (NVIDIA, NVIDIA RTX Spark N1X ... Direct3D11 vs_5_0 ps_5_0,
D3D11)`). There `up`, `doctor`, `all` and `down` passed from Windows PowerShell 5.1 with no changes to the helper:
the title was ready in 30-35 s on the dev client with a fresh profile, `all` took about 5 minutes, play fps was
2 / 3 / 20 / 55 / 56 at 0 / 5 / 15 / 30 / 60 s, the range walk moved the kong 10.7 m, the room pings were 23 and 39 ms,
and `__kr.errors` and the console errors were empty. `up --prod` with `play --secs 30`, and `room --url` against
`npm run dev` plus a `KR_EVENT_MODE=0` `npm run server` started by hand, passed too.

On `nogpu` (validated on a 4-vCPU, 16 GB Ubuntu 24.04 cloud machine): run `npx playwright install chromium` once (add
`--with-deps` if libraries are missing); the helper uses a 640x360 viewport, because at 1600x900 SwiftShader trips
the game's own 90 s settle timeout (`[ready] timed out waiting for: veg-impostors`, `__kr.stage === "failed"`). The
title takes about 2.5 minutes, play about 5, and `all` about 9. One `all` run on that machine was killed at a
12.6 GB memory cap; if that happens, run `boot` and `play` one at a time. On `nogpu` the title takes minutes and frames are seconds apart, so `all` runs only `boot` and `play` (20 s) with long
timeouts. Never judge looks or performance from a `nogpu` run; say "smoke only" in the PR.

## Launch

1. `npm ci` once per checkout. Use Node 22.12 or newer: on Ray's Mac the default `node` is 18, so put Homebrew's first
   (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`). On Windows run the commands in PowerShell or cmd; the helper
   needs no shell env syntax. Git Bash works as well. On Windows on ARM, install the arm64 builds of Node and Chrome:
   an x64 browser runs emulated, and its frame rate says nothing about the game.
2. `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up`. It spawns `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5417 --strictPort` and
   `node node_modules/tsx/dist/cli.mjs server/index.ts` with `KR_EVENT_MODE=0 KR_PORT=3120`, logs to
   `shots/verify/logs/`, records the pids in `shots/verify/.instance.json`, and returns once `/health` and the page
   answer (about 15 s). The client proxies `/ws`, `/api` and `/health` to `KR_PORT`, so this pair never touches the
   default :5317/:3020 that a person may be using. `--web` / `--port` pick other ports; `up --prod` serves the built
   `dist/` from the game server alone (run `npm run build` first; the built title is the "playtest" variant).
3. Ready = `up` prints `{"ok":true,...}`. If a port is taken it refuses instead of driving someone else's instance;
   if a previous instance is only partly alive it refuses too: run `down`, then `up`.

To drive an instance you started yourself (for example `npm run dev` plus `KR_EVENT_MODE=0 npm run server`), pass
`--url http://localhost:5317 --port 3020` to `doctor` and the drives; `down` then has nothing to stop. The env
syntax there is POSIX: in PowerShell it is `$env:KR_EVENT_MODE = "0"; npm run server`, in cmd
`set KR_EVENT_MODE=0&& npm run server`.

Agents on Windows: `up` prints its JSON line in about 15 s, but an agent shell tool that runs it in the foreground
does not return until its own timeout, even with `up`'s output redirected to a file. The instance itself stays up.
The cause is not pinned down: the helper gives its children log files as stdout and stderr, so the likely holder is a
handle or job object they inherit from the calling shell rather than their stdio. Start `up` as a detached or
background command and confirm it with `doctor`.

## Doctor

`node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor` answers "is this instance worth driving?" and prints one JSON object with `ok` and a `checks` list: Node
version, `node_modules`, the pids from `up` alive, client answering, game server `/health`, a fresh page reaching
`window.__kr.ready === true`, and the WebGL renderer string for the profile. Run it before the first drive, after any
failed drive, and whenever something looks odd. A failing doctor means fix or relaunch (`down` then `up`), not drive.

## Drive

Each drive opens fresh browser contexts at 1600x900 (640x360 on `nogpu`), waits for `window.__kr.ready` (the title is playable), acts only
through what a player touches (buttons, keys), and reads results from the game's own debug handle:

- `window.__kr.ready` / `__kr.stage`: boot state (`"ready"` or `"failed"`). `__kr.errors`: every boot error, uncaught
  error and rejection the page saw. A drive fails if it is non-empty.
- `window.__kr.fps()`: live frame rate. `window.__kr.game.inMatch`: true once a match runs.
  `window.__kr.game.state()`: phase, position, hp, shield, alive, ping, storm, slots, actors, loot.
- URL flags: `?debug` shows boot errors on screen, `?seed=N` replays the same practice match (plane path, storm,
  loot), `?dev` forces the full title (Trios/Solo, bot difficulty, Friends) even on a built bundle.

Stable handles: the primary button is `button.tn-play-cta` (its accessible name is "Play vs bots" on the dev client
and "Play" on the built/playtest title, "Start match" for a lobby host). Firing range is the `Firing range` button in
`.tn-play-links` (or the Training tab). Friends is a `<summary>` that opens "Create lobby" and the `Lobby code` input
with a `Join` button; the room code shows in `.tn-play-roomcode`. Enter on the title is the same as the primary button.

The recipes, entry points and proof per feature live in [features/README.md](features/README.md). Read the feature
file before driving it, and drive every entry point a change touches, not only the convenient one.

## Evidence

Every drive writes to `shots/verify/<profile>-<yyyymmdd-hhmmss>/` (`shots/` is git-ignored; `--out DIR` overrides):
PNG screenshots named `<feature>-<step>.png` and `result.json` with the platform, Node version, GPU string, boot
time, fps samples, game state before and after each action, `__kr.errors`, and the first 20 console errors. Each
command also prints one JSON line per feature and exits 0 only when every feature passed.

Proof standard: the action and its result, not only the last frame. Every match drive also requires the newest
authoritative snapshot tick (`snapTick` in the result, from `__kr.game.cm.snapTick()`) to keep rising, so a match that
stalls after it starts fails. Play proves the match started and advanced (fps samples at 5/15/30/60 s, and the plane
phase reached on GPU runs of 30 s or more; on `nogpu` match time lags wall time, so only the tick check applies). Range proves input reaches the simulation (W held 2 s moves the kong;
`walkedM` in the result). Room proves two real clients share one server match (both `inMatch`, both receiving snapshots, non-zero `ping`).
For a PR, attach the relevant screenshots and quote the `result.json` lines that prove the change; name the profile.

## Cleanup

`node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs down` kills only the process trees it started (from `.instance.json`; `taskkill /T` on Windows, the process group
elsewhere) and deletes that file. It never kills by name and never touches :5317/:3020. Screenshots, `result.json`
and `shots/verify/logs/` survive; delete old run folders yourself when you no longer need them. Run `down` after a
failed iteration too, so broken attempts do not strand servers.

## Verifiers that need no browser

Run these alongside the drives; they are faster and cover what a screenshot cannot. Check `npm run` for the current
list: commands land over time, and a newer one beats a recipe here.

| Command | Proves | GPU |
|---|---|---|
| `npm run build && npm test` | types, movement, swimming, actors, walk graph, solver, glass, wire/matrix/geometry/http/splat parity, a headless seed-42 match, admin lobby red team | no |
| `npm run sim` | a full 50-bot trios match (seed 42): winner, kills, tick cost | no |
| `npm run netlab` (`-- --kill`) | hit registration under 20-320 ms RTT with the real client and server code | no |
| `npm run bench:host` / `npm run bench:server` | host tick cost; 50 players over 100 real sockets against a local built server | no |
| `node tools/shot.mjs <view>` | fixed-camera captures of a POI or biome on the real GPU | yes |

On Windows: `npm test` reports 10 of its 11 checks failed in 0.0 s each, because `tools/run-tests.mjs` spawns `npx`
and `npm` without a shell. Run the failed checks one by one (the commands are in that file); `swimming` and `building
walk graph` also fail on Windows paths in the tests themselves (`URL.pathname` gives `/C:/...`). Say which checks you
could not run in the PR; CI on Linux runs them all. `npm start` and `npm run kongbot:db` use POSIX shell syntax and
do not run from cmd or PowerShell: use `up --prod` to serve `dist/`. `node tools/shot.mjs` launches Playwright's own
Chromium unless `KR_CHROME` names a browser; set it to Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`).

Verifiers being added on the fork (an online-match check, pass/fail thresholds for sim and netlab, a no-GPU boot
check, an asset-licence check against CREDITS.md) will appear as `npm run` scripts or under `tools/`; prefer them
when present and add a row here in the same PR that adds them.

## Gotchas

- The first ~15 s of a match run at 2-6 fps on a real GPU while the island streams in ("Warm-up · loading island N %"
  in the HUD; 3 fps at 5 s and 20 at 15 s on the RTX Spark); judge fps from the 30 s sample on.
- The primary button's label differs by build (above). Select `button.tn-play-cta`, never the text "Play": the top
  nav also has a "Play" tab, and clicking it does nothing visible.
- Two headed windows on one machine fight over focus: the unfocused one can open the pause menu. The helper runs
  headless contexts, which do not; pass `--headed` only to watch.
- If doctor shows SwiftShader or "Basic Render Driver" on Mac or Windows, Chrome fell back to software rendering
  (remote desktop session, missing driver, blocklist); fix that before driving, or the run is a `nogpu` smoke at best.
- Never point the helper at kongroyale.com or any server you did not start (AGENTS.md rule 7).

## Keeping this skill honest

The feature map rots when the game changes. Run the pstack `/maintain-verification-skill` pass on this skill
(`.agents/skills/verify-kongroyale`) after a change to the title screen, lobby, match flow or `window.__kr`, and
before a release. It reads the source behind every file in `features/`, drives every feature live with this helper,
and ships at most one PR of proven corrections to this folder only. See [features/README.md](features/README.md)
for what each audit should check.
