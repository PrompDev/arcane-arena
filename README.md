# Arcane Arena

Arcane Arena is an original, clean-room browser arena prototype: fast movement,
elemental spell combinations, private room links, and server-authoritative
combat for up to four players. The client renders with WebGPU and falls back to
Canvas 2D when WebGPU is unavailable.

No code, art, audio, or other assets from *Wizard of Legend* are included.

## Play online

The public prototype is available at
[arcane-arena-duels.tomdavie016.chatgpt.site](https://arcane-arena-duels.tomdavie016.chatgpt.site).
Create a room, copy its five-character invite link, and open that link on up to
four computers or browser sessions.

## Requirements

- Node.js 22.13 or newer
- A current browser with WebGPU support for the full renderer
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
| Aim | Mouse | Right stick |
| Cinder Shot | Left mouse button | Right trigger or south button |
| Tide Ring | Right mouse button | Left trigger or east button |
| Volt Lance | E | West or north button |
| Phase Dash | Space or Shift | Either shoulder button |

Tide Ring applies `soaked`; hitting a soaked rival with Volt Lance consumes the
status for bonus damage and a short stun.

## Architecture

- `app/` contains the Vinext/React client and accessible arena interface.
- `app/game/renderer.ts` owns the native WebGPU renderer and Canvas 2D fallback.
- `app/game/ArenaGame.tsx` handles input, room links, WebSocket state, smoothing,
  gamepad support, and the HUD.
- `arena-server/` is a separate Cloudflare Worker. One SQLite Durable Object owns
  each room, uses the hibernation WebSocket API, and runs the 30 Hz authoritative
  simulation only while players are connected.
- `.openai/hosting.json` configures only the frontend site. It does not bind the
  Durable Object server.

The server is the source of truth for movement, collision, cooldowns, damage,
status effects, scores, and respawns. Clients send bounded input snapshots and
render the snapshots returned by the room.

## Verify

Run the complete local check from the project root:

```powershell
npm run verify
npm run lint
```

`verify` builds and server-renders the frontend, checks the Worker types, and
runs the Durable Object simulation and protocol tests. Server-only commands are
also available through `npm run check:server` and `npm run test:server`.

## Deploy

The multiplayer server and frontend are separate deployments. Deploy in this
order:

1. From `arena-server/`, run `npm run check`, `npm test`, then `npm run deploy`.
2. In the frontend build environment, set `NEXT_PUBLIC_ARENA_SERVER` to the
   Worker's public HTTPS or WSS origin, for example
   `https://arcane-arena-server.<account>.workers.dev`.
3. From the project root, run `npm run build`, then publish the saved frontend
   version through Sites.
4. Open the hosted site in two browser sessions, join one room, and smoke-test
   movement, all four actions, damage, respawn, and reconnection.

`NEXT_PUBLIC_ARENA_SERVER` is consumed at build time. A hosted frontend without
it deliberately stays offline rather than silently trying localhost, and a
Sites deployment by itself is therefore not a multiplayer deployment.

See `arena-server/README.md` for protocol and simulation details.
