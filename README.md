# Arcane Arena

Arcane Arena is an original, clean-room 3D browser arena: directional swordplay,
fast movement, elemental spell combinations, private room links, and
server-authoritative combat for up to four players. The client uses Babylon.js
with WebGPU by default and a WebGL 2 fallback.

No code, art, audio, or other assets from *Wizard of Legend* are included.

## Play online

The public prototype is available at
[arcane-arena-duels.tomdavie016.chatgpt.site](https://arcane-arena-duels.tomdavie016.chatgpt.site).
Create a room, copy its five-character invite link, and open that link on up to
four computers or browser sessions.

## Requirements

- Node.js 22.13 or newer
- A current browser with WebGPU or WebGL 2 support
- A Cloudflare account only when deploying the multiplayer Worker

## Run locally

Install both packages once:

```powershell
npm install
npm --prefix arena-server install
```

Then start the authoritative server and frontend in separate terminals:

```powershell
npm run dev:server
```

```powershell
npm run dev
```

Open `http://localhost:3000`. Local play automatically connects to
`ws://localhost:8787`; copying `.env.example` to `.env.local` makes that choice
explicit. Share the generated `?room=ABCDE` URL with another local browser tab
to join the same room.

## Controls

| Action | Keyboard and mouse | Gamepad |
| --- | --- | --- |
| Move | WASD or arrow keys | Left stick |
| Look / choose combat direction | Mouse | Right stick |
| Draw and release sword attack | Left mouse button | Right trigger |
| Directional guard | Right mouse button | Left trigger |
| Feint | Q | West button |
| Cinder Shot | 1 | South button |
| Tide Ring | 2 | East button |
| Volt Lance | 3 | North button |
| Phase Dash | Space or Shift | Either shoulder button |
| Toggle third / first person | V or the HUD camera button | HUD camera button |

Holding an attack charges it from 20 to 40 damage over two seconds. Releasing
commits the swing after a 350 ms minimum draw. Matching a guard direction blocks
the hit and stuns the attacker; Q cancels an early draw or release as a feint.

Tide Ring applies `soaked`; hitting a soaked rival with Volt Lance consumes the
status for bonus damage and a short stun.

## Architecture

- `app/` contains the Vinext/React client and accessible arena interface.
- `app/game/renderer.ts` lazily loads the Babylon.js renderer so server rendering
  does not evaluate browser graphics APIs.
- `app/game/babylon/` owns the WebGPU/WebGL engine, third/first-person camera,
  animated fighter instances, licensed dungeon kit, and 3D spell effects.
- `app/game/ArenaGame.tsx` handles input, room links, WebSocket state, smoothing,
  gamepad support, and the HUD.
- `arena-server/` is a separate Cloudflare Worker. One SQLite Durable Object owns
  each room, uses the hibernation WebSocket API, and runs the 30 Hz authoritative
  simulation only while players are connected.
- `.openai/hosting.json` configures only the frontend site. It does not bind the
  Durable Object server.

The server is the source of truth for movement, collision, attack phases,
charge, directional guards, feints, stuns, spells, cooldowns, damage, scores,
and respawns. Clients send bounded input snapshots and render the snapshots
returned by the room.

The animated mage, sword, dungeon floor, barriers, pillars, and torches are
from CC0 KayKit packs. The melee design adapts timing and state ideas from the
MIT-licensed Advanced Melee System while keeping collision authoritative on the
server. See `THIRD_PARTY_NOTICES.md` for exact sources and licence copies.

## Verify

Run the complete local check from the project root:

```powershell
npm run verify
npm run lint
```

`verify` builds and server-renders the frontend, checks the Worker types, and
runs the Durable Object simulation and protocol tests. Server-only commands are
also available through `npm run check:server` and `npm run test:server`.

After deploying the public Worker, run `npm run smoke:live`. It opens two real
WebSocket clients, moves them into range, and verifies a directional block,
locked attack facing, and a simultaneous melee trade against production.

## Deploy

The multiplayer server and frontend are separate deployments. Deploy in this
order:

1. From `arena-server/`, run `npm run check`, `npm test`, then `npm run deploy`.
2. If deploying your own server, set `NEXT_PUBLIC_ARENA_SERVER` in the frontend
   build environment to that Worker's public HTTPS or WSS origin.
3. From the project root, run `npm run build`, then publish the saved frontend
   version through Sites.
4. Open the hosted site in two browser sessions, join one room, and smoke-test
   movement, all four actions, damage, respawn, and reconnection.

`NEXT_PUBLIC_ARENA_SERVER` is consumed at build time. When it is omitted,
localhost uses `ws://localhost:8787` and hosted builds use Arcane Arena's public
authoritative Worker at
`https://arcane-arena-server.drdeandrehyde.workers.dev`.

See `arena-server/README.md` for protocol and simulation details.
