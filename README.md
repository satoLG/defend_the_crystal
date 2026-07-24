# 💎 Defend the Crystal

Co-op 3D tower defense for the browser — **1 to 4 players** pick a class,
build a maze of blocks and towers, and fight side by side to keep monsters
away from the crystal. Medieval looks, arcade heart, plays great on desktop
**and** mobile (full touch controls, cross-play between them).

Unlike classic tower defense, the path to the crystal starts wide open:
enemies can walk straight to it. Your obstacles and towers *shape* their
path — you can make it long and painful, but you can never seal it
completely. Your character fights too: stand in the way, draw aggro, kite
enemies around your maze while towers grind them down.

![Kenney assets, three.js rendering](https://img.shields.io/badge/three.js-r185-blue)

## Play

This is an npm-workspaces **monorepo**:

- [`apps/web`](apps/web) — the browser game (Vite + three.js), deployed to Vercel.
- [`apps/server`](apps/server) — the authoritative multiplayer server (Node + Socket.IO), deployed to Render.
- [`packages/shared`](packages/shared) — game config + the simulation (`sim/`), shared by both.

```bash
npm install            # installs all workspaces
npm run dev            # runs the server (:3001) and the web dev server together
# or, in two terminals:
npm run dev:server
npm run dev:web
npm run build          # static build of the web app in apps/web/dist/
```

For local multiplayer, open two browser tabs on the dev server: create a room
in one, join with the 5-letter code in the other. The web app connects to
`http://<host>:3001` by default; override with `VITE_SERVER_URL` (build time)
or `?server=<url>` (per tab).

> **Multiplayer is client–server.** The server owns the authoritative
> simulation and streams ~18 Hz snapshots over a single reliable WebSocket;
> every browser is a plain client that sends its inputs/actions and renders
> interpolated snapshots with client-side movement prediction. There is no
> "host player" — if any player (even the room's owner) drops, the match
> keeps running, and a brief reconnect restores the same hero. This replaces
> the old peer-to-peer WebRTC transport, which failed on strict NATs.

### Deploy

- **Frontend → Vercel.** Build command `npm run build`, output
  `apps/web/dist` (see [`vercel.json`](vercel.json)). Set `VITE_SERVER_URL`
  per environment to your Render server URL.
- **Server → Render.** One-click via [`render.yaml`](render.yaml) (Blueprint).
  Free tier hibernates after ~15 min idle; the first connection then wakes it
  (~30–50 s) and the client shows a "connecting to the server…" state.
- **Previews.** Vercel builds a preview per PR automatically. Render's
  automatic per-PR previews need a **paid** workspace; on the free plan use one
  stable server for Preview builds (production, or the optional
  `dtc-server-staging` service in `render.yaml`) and `?server=<url>` to point a
  preview at any specific server.

## How it works

1. **Create a match** — you get a 5-letter room code. Share it (📋 copy /
   🔗 share link). Friends can join in the lobby *or drop in mid-battle*.
2. **Pick a class** — stats differ across HP, defense, attack, range,
   attack speed and movement speed:

   | Class | HP | DEF | ATK | Range | Atk speed | Move |
   | --- | --- | --- | --- | --- | --- | --- |
   | 🪓 Berserker | ★★★ | ★★ | **★★★★** | ★ | ★★ | ★★ |
   | 🛡️ Tanker | **★★★★** | **★★★★** | ★★ | ★ | ★★ | ★ |
   | 🏹 Archer | ★ | ★ | ★★ | ★★★ | **★★★★** | **★★★★** |
   | 🔮 Mage | ★★ | ★★ | ★★ (AoE) | **★★★★** | ★★ | ★★ |

3. **Build phase** — place blocks (limited stock, replenished every wave,
   per character) and buy towers with the shared point pool:
   **Ballista** (fast, single target), **Catapult** (huge range, mid AoE,
   slow), **Cannon** (big AoE, high damage, short range, slow).
   Towers have 3 levels — tap one to upgrade or sell.
4. **Fight** — your character auto-attacks the nearest enemy (attacks go
   *through* walls and towers). Enemies aggro whoever stands closest to
   their path and chase until that character dies or escapes. Knockback
   flies both ways. Out of combat you regenerate HP — kite and survive.
5. **Survive** — each kill feeds the point pool and levels your character
   up (more HP/attack, during the match). Every 5th wave brings a
   sub-boss, every 10th a boss — and after each 10th wave the party rests
   at a **checkpoint**: everyone heals, and the next wave only starts when
   every player is ready. If too many enemies reach the crystal
   (10 breaches — bosses count extra), it shatters and the run ends.

Difficulty scales with the party: solo players face gentler waves and get
more blocks and more points per kill; a full squad of four faces the horde
at full strength.

### Enemies

Skeletons (fast fodder), zombies (slow, tanky), 👻 ghosts (*fly straight
over your maze*), skeleton archers (stop and shoot arrows at your
characters), orcs (heavy), and vampires (fast **and** heavy — every few
seconds they *vault over your walls* in a swarm of bats when it's a
shortcut). Sub-bosses (every 5th wave) are scaled-up versions of the
strongest rank alive — bigger, meaner, worth more.

Every 10th wave a **named boss** stomps in, on rotation:

- **Coveiro** — the giant gravedigger raises tombs out of the ground
  mid-path that keep disgorging zombies and skeletons
- **Tiro Cego** — a giant skeleton archer that volleys arrows at *every*
  character at once
- **Zé do Caixão** — a giant vampire hauling his own coffin; chains two
  wall-vaults back to back before the cooldown kicks in
- **Abobrado** — a giant ghost lobbing carved pumpkins with area damage

## Controls

| | Desktop | Mobile |
| --- | --- | --- |
| Move | WASD / arrows | touch anywhere & drag (virtual joystick) |
| Build | `1-4` select card, hover + click to place | tap card, tap cell to preview, tap again to confirm |
| Manage tower/block | click it | tap it |
| Cancel | `Esc` / right-click | tap the selected card |
| Start wave (owner) | `Space` or button | button |

## Tech

- [three.js](https://github.com/mrdoob/three.js) — rendering (animated GLTF minis, night ambience)
- [miniplex](https://github.com/hmans/miniplex) — ECS for the authoritative simulation
- [yuka](https://github.com/Mugen87/yuka) — enemy steering (seek + separation) on top of a BFS flow field
- [Socket.IO](https://socket.io) — reliable client↔server realtime transport; server-authoritative
  sim, ~18 Hz snapshots with client interpolation, client-side movement prediction, auto-reconnect
- [tiks](https://github.com/rexa-developer/tiks) — procedural arcade UI sounds, zero audio files
- [Kenney](https://www.kenney.nl) CC0 assets — see [CREDITS.md](CREDITS.md)

The whole balance sheet (classes, towers, enemies, waves, 1–4 player
scaling) lives in [`packages/shared/src/config.js`](packages/shared/src/config.js) — tweak away.
