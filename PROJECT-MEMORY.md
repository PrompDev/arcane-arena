# Arcane Arena project memory

## Scope

- Started 2026-07-11 as an original, clean-room browser prototype inspired by
  the feel of fast spell-combination arena combat.
- Do not copy, extract, or distribute *Wizard of Legend* code, art, audio, or
  other assets. This project uses its own presentation and implementation.
- Target: responsive movement, three elemental spells plus a dash, private room
  links, and authoritative online arenas for up to four players.

## Current shape

- Vinext/React frontend with a direct WGSL WebGPU renderer and Canvas 2D
  fallback.
- Separate Cloudflare Worker plus one SQLite Durable Object per room.
- Server-authoritative 30 Hz movement, collisions, spell interactions, health,
  KOs, scores, and respawns.
- Public room server deployed and verified with two live WebSocket clients.
- Two-client room joining, shared authoritative movement, and projectile
  replication are covered by both automated and live smoke tests.

## Next actions

1. Make the owner-only Sites deployment public when the owner explicitly
   approves access for anyone with the link.
2. Add identity-preserving reconnection and tune client prediction from live
   latency playtests.
3. Resolve same-tick spell trades fairly before expanding modes,
   matchmaking, progression, or art production.
