# Kong Royale

A 50-player banana battle royale that runs in your browser. Play it at [kongroyale.com](https://kongroyale.com).

![The Kong Royale title screen](.github/assets/title.jpg)

You drop from the Banana Co. plane onto a jungle island, loot chests, and fight 49 other kongs while the storm closes
in. Play solo or in trios; bots fill any empty seats.

The client is built with [three.js](https://threejs.org). The multiplayer server is Node.js with WebSockets. Both run
the same simulation code from `shared/`, and the server has the final say on every hit, pickup and storm tick.

![Freefall over the island](.github/assets/gameplay.jpg)

## Status

- **Status:** playable and in active development (version 0.2.0).
- **To play:** a desktop browser with WebGL2, a decent GPU, and a keyboard and mouse or a controller. There are no
  touch controls, so phones and tablets don't work yet.
- **Limits:** there are no accounts and the server saves nothing between matches. Lobbies live in one server
  process's memory.

## Run it

You need [Node.js](https://nodejs.org) 22.12 or newer.

```sh
npm ci
npm run dev
```

Open <http://localhost:5317/> and press **Play**. That starts a match against 49 bots that runs entirely in your
browser, so you don't need the server. Pick **Easy**, **Standard** or **Hard** bots on the title screen.

Until you start the server (below), the terminal keeps complaining that it can't reach `/health` on port 3020. That's
harmless: practice matches don't use the server.

### Controls

| Key | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Left / right mouse | Fire / aim |
| Space | Jump, leave the plane, pull the chute |
| Left Shift / C | Sprint / crouch |
| R | Reload |
| E | Interact: pick up, open chests, get in vehicles |
| 1-5 or mouse wheel | Switch weapon |
| G | Throw a banana bomb |
| Tab / M | Inventory / map |
| Middle mouse or Z | Ping |
| B | Push to talk (squad voice) |
| Esc | Menu and settings |

You can rebind every key in **Settings**. Controllers work too.

### Firing range

**Firing Range** on the title screen has every gun at every rarity, every heal and every ammo type, with targets from
10 to 205 m. It uses the real match code for damage, falloff, spread and hit registration, so it's the quickest place
to test a weapon change.

### Online rooms

To play with friends on your own machine, start the server in a second terminal:

```sh
KR_EVENT_MODE=0 npm run server
```

Then open **Friends** on the title screen to create a room or join one by its code. `KR_EVENT_MODE=0` lets players
create their own rooms; see [HOSTING.md](HOSTING.md) for what it and the other settings do.

## Project layout

| Folder | What's in it |
|---|---|
| `client/src/` | The browser game: rendering, UI, audio, input and client prediction |
| `client/src/world/` | The island you see: terrain, water, plants, sky, and one folder per location |
| `shared/sim/` | The game rules, run by both server and browser: movement, weapons, loot, storm, bots, vehicles |
| `shared/net/` | The network protocol and the loop that runs a match |
| `shared/world/`, `shared/pois/` | The map: the terrain generator and the collision shapes of every location |
| `server/` | The Node server: lobbies, the 60 Hz match loop, admin lobbies, bug reports, voice relay |
| `public/assets/` | Models, textures, sounds and fonts the browser downloads |
| `tools/` | Tests, benchmarks and the admin key tool |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

For benchmark-driven optimization work, read [PERFORMANCE.md](PERFORMANCE.md). Agent assignments and a copyable
handoff prompt are in [PERFORMANCE_HANDOFF.md](PERFORMANCE_HANDOFF.md).

## Check your changes

```sh
npm run build   # build the game into dist/ (about 15 s)
npm test        # types, movement, swimming, animation, path finding, network parity, a headless match, security
```

Run the build first: one of the tests uses the built admin pages. The tests need no GPU, network or database and take
about two minutes. The same checks run on every pull request.

## Run your own server

```sh
npm ci
npm run build
npm start
```

That serves the game and the multiplayer server on one port, 3020 by default. A build shows a simpler title screen
with one Play button and no Solo / Trios, bot difficulty or Friends. Build with `VITE_KR_PLAYTEST=0 npm run build`
for the full one. [HOSTING.md](HOSTING.md) lists every setting and explains how to run it safely on the internet.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every change goes through a pull request, and the Kong Royale Committee of
Truth and Prosperity reviews it before it can reach the live game. Using an AI coding agent? Point it at
[AGENTS.md](AGENTS.md).

Questions: [Discussions](https://github.com/MaximilianHansen/kongroyale/discussions). Ideas for the game: open an **Idea** issue.

Found a security problem or a cheat? Don't open an issue. See [SECURITY.md](SECURITY.md).

## Licence

The code and the game's own art and audio are under the [MIT licence](LICENSE). A few files come from other people
under their own licences; they're listed in [CREDITS.md](CREDITS.md). The MIT licence covers the code and files, not
the **Kong Royale** name and logo: please don't use those for your own game or in a way that suggests it's official.
