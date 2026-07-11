# Arcane Arena server

Authoritative four-player arena backend built as a Cloudflare Worker with one
SQLite-backed `ArenaRoom` Durable Object per room.

## Runtime model

- `GET /health` returns service health and protocol limits.
- `GET /room/:room?name=<display name>` upgrades to a WebSocket.
- Room slugs are 1–48 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`.
- Display names are normalized, stripped of control characters, collapsed to
  24 code points, and default to `Mage`.
- Each room accepts at most four live sockets.
- The room runs an authoritative 30 Hz loop only while at least one socket is
  connected. Delayed callbacks catch movement and projectiles up in at most
  three collision-safe substeps; excess delay is dropped instead of becoming
  one large tunneling step.
- The loop checkpoints state to Durable Object SQLite every 15 ticks and on
  joins or disconnects. Connection identity and sequence state are also stored
  in WebSocket attachments and reconstructed in the Durable Object constructor.
- The Hibernation WebSocket API is used. A live 30 Hz match intentionally
  remains active because scheduled callbacks prevent hibernation; the interval
  is removed as soon as the final socket leaves.

The arena uses coordinates from `(0, 0)` to `(24, 14)` and includes five
circular pillars. All movement, collision, damage, status effects, kills,
deaths, and respawns are decided by the server.

## Combat

- Movement accelerates quickly toward a 6.2 unit/s top speed and uses strong
  friction when input stops.
- Dash is a short 14.2 unit/s burst with a 720 ms recharge.
- The Arcane Blade uses an authoritative four-direction draw/release state
  machine. `up` is an overhead cut, `down` is a stab, and `left`/`right` are
  sweeping slices. A press starts drawing and release commits the attack after
  a minimum 350 ms draw.
- Charge is normalized from `0` to `1` between the 350 ms minimum draw and the
  2,000 ms maximum, scaling sword damage from 20 to 40. The server resolves the
  nearest opponent once in the weapon's forward range and direction-specific
  arc, so a release cannot damage the same target on multiple ticks.
- Feint cancels a draw or the first 350 ms of a release before its hit frame.
  Feints have a 500 ms cooldown. A landed hit stuns its target for 300 ms.
- A directional block must face the attacker within a 65-degree half-angle and
  cover the incoming line. Overhead and stab attacks use matching `up`/`down`
  blocks; lateral attacks are mirrored from the defender's view (`left` attack
  requires `right` block and vice versa). A successful block deals no damage
  and stuns the attacker for 650 ms.
- Cinder Shot is a rapid 12-damage projectile with a 170 ms recharge.
- Tide Ring deals 8 damage, pushes nearby opponents, and applies `soaked` for
  four seconds.
- Volt Lance is an aimed, pillar-blocked hit for 20 damage. A soaked target
  takes 18 bonus damage, is stunned for 650 ms, and consumes the soaked status.
- Players have 100 health and respawn after 1.7 seconds while retaining score.

## Wire protocol

Client input:

```json
{
  "type": "input",
  "seq": 1,
  "moveX": 0,
  "moveY": 0,
  "aimX": 1,
  "aimY": 0,
  "dash": false,
  "primary": false,
  "secondary": false,
  "utility": false,
  "attackHeld": false,
  "blockHeld": false,
  "feint": false,
  "combatDirection": "up"
}
```

Movement and aim are normalized and bounded to the unit circle. Sequences are
bounded integers and stale inputs are ignored. Action fields only accept the
literal boolean `true`. Combat direction accepts only `up`, `down`, `left`, or
`right` and safely defaults to `up`; clients using the older packet shape safely
default all melee actions to inactive. Text frames are capped at 2,048 UTF-8
bytes, and each connection is limited to 120 messages per one-second window.

Clock probe:

```json
{ "type": "ping", "clientTime": 1750000000000 }
```

Welcome:

```json
{
  "type": "welcome",
  "id": "player UUID",
  "room": "practice",
  "serverTime": 1750000000000,
  "arena": {
    "width": 24,
    "height": 14,
    "tickRate": 30,
    "respawnMs": 1700,
    "pillars": [{ "x": 12, "y": 7, "r": 0.9 }]
  }
}
```

Snapshots:

```text
{
  type: "snapshot",
  tick,
  serverTime,
  players: [{
    id, name, x, y, vx, vy, aimX, aimY, radius,
    health, maxHealth, kills, deaths, alive, respawnAt,
    soakedUntil, stunnedUntil, dashUntil,
    combatPhase: "idle" | "drawing" | "releasing" | "blocking" | "stunned",
    combatDirection: "up" | "down" | "left" | "right",
    combatStartedAt,
    charge,
    weapon: "arcane-blade",
    cooldowns: { dash, primary, secondary, utility }
  }],
  projectiles: [{
    id, ownerId, spell: "cinder-shot", x, y, vx, vy, radius, expiresAt
  }],
  effects: [{
    id,
    type: "dash" | "cinder-impact" | "tide-ring" | "volt-lance" | "spawn" | "death",
    ownerId, x, y, x2?, y2?, radius?, createdAt, expiresAt
  }]
}
```

All timestamps and cooldown values are Unix epoch milliseconds. Pong messages
echo `clientTime` and add `serverTime`.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run types
npm run check
npm test
npm run dev
```

The local WebSocket URL is
`ws://localhost:8787/room/practice?name=Your%20Name`.

`npm run deploy` is provided for an intentional deployment. It was not run as
part of the initial build. The Wrangler configuration uses the 2026-07-11
compatibility date, `nodejs_compat`, generated environment types, SQLite Durable
Object migration `v1`, and Workers Logs/traces observability.

Useful Cloudflare references:

- [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
