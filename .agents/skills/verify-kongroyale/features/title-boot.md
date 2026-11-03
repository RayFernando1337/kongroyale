# Title and boot

Opening the game shows a loading screen while the island's first modules build, then the title: the Kong, "Rule the
island.", the Play button, Firing range, Learn controls, Friends and Settings. The title is playable once
`window.__kr.ready` is true.

## Sub-features

- `boot-ready` the page reaches `__kr.ready === true` with `__kr.stage === "ready"`.
- `boot-clean` `__kr.errors` stays empty; `?debug` would show any boot error on screen.
- `boot-gpu` the WebGL renderer is the platform's real GPU (Metal on Mac, D3D11 on Windows).
- `boot-cta` the primary button is present with the build's label.

## How to get to it (user POV)

- Open the client URL (dev: `http://127.0.0.1:5417/` from `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up`; a person's own dev server is `http://localhost:5317/`).
- A built bundle: `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up --prod`, then the same drives (the title is the one-button playtest variant).

## Driving it with kr-verify

Preconditions:

- `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor` is ok.

- **Boot.** Run `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs boot`. Output line `{"feature":"boot","ok":true,...}`; `result.json` has `boot.ready: true`, `boot.gpu` and `boot.readyAtMs`.
- **Proof.** `boot-title.png` shows the title with the Play button; `playButton` in the result reads "Play vs bots" (dev) or "Play" (built).

## Gotchas

- Boot takes about 25 s on an M3 Max and minutes on SwiftShader; the helper waits up to 4 min (15 min on `nogpu`).
- `readyAtMs` is page time to the playable title. Compare it between runs on the same machine only.
