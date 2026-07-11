# Arcane Arena project memory

## Scope

- Started 2026-07-11 as an original, clean-room browser prototype inspired by
  the feel of fast spell-combination arena combat.
- Do not copy, extract, or distribute *Wizard of Legend* code, art, audio, or
  other assets. This project uses its own presentation and implementation.
- Target: responsive movement, three elemental spells plus a dash, private room
  links, and authoritative online arenas for up to four players.

## Current shape

- Vinext/React frontend with a Babylon.js 3D renderer: WebGPU by default and
  WebGL 2 fallback.
- Third-person follow camera is the default; V and the HUD toggle an optional
  first-person view. Server x/y remains the authoritative ground plane and maps
  to client x/z.
- CC0 KayKit Adventurers and Dungeon Remastered assets provide the animated
  mage, sword, floor, low rails, collision pillars, and torches. Exact notices
  and licence copies are tracked in `THIRD_PARTY_NOTICES.md` and
  `public/assets/licenses/`.
- Separate Cloudflare Worker plus one SQLite Durable Object per room.
- Server-authoritative 30 Hz movement, collisions, held draw/release attacks,
  four combat directions, charge damage, directional guards, feints, hit/block
  stuns, spell interactions, health, KOs, scores, and respawns. Attack facing is
  locked when drawing, pillars stop melee traces, and strikes due on one tick
  resolve as a batch so simultaneous trades do not depend on player ID order.
- The melee behavior adapts timing/state ideas from the MIT AMS project while
  retaining server-owned hit validation; no Roblox binaries/assets/IDs were
  copied.
- Public room server:
  `https://arcane-arena-server.drdeandrehyde.workers.dev`.
- Public frontend deployed at
  `https://arcane-arena-duels.tomdavie016.chatgpt.site`.
- Public source repository: `https://github.com/PrompDev/arcane-arena`.
- Two-client room joining, shared authoritative movement, and projectile
  replication are covered by both automated and live smoke tests.

## Next actions

1. Add local input prediction/reconciliation; the close third-person camera
   makes 30 Hz authoritative stepping more visible than the former overhead
   renderer.
2. Add camera obstruction handling and a dedicated first-person weapon pose.
3. Resolve same-tick spell trades fairly before expanding modes,
   matchmaking, progression, or art production.
