import { describe, expect, it } from "vitest";

import {
  INPUT_FRESHNESS_TIMEOUT_MS,
  TICK_INTERVAL_MS,
  addPlayer,
  applyPlayerInput,
  buildSnapshot,
  createArenaState,
  expirePlayerInputIfStale,
  restoreArenaState,
  serializeArenaState,
  stepArena,
} from "../src/game";
import type { InputMessage } from "../src/protocol";

function input(seq: number, overrides: Partial<InputMessage> = {}): InputMessage {
  return {
    type: "input",
    seq,
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    dash: false,
    primary: false,
    secondary: false,
    utility: false,
    ...overrides,
  };
}

describe("authoritative arena simulation", () => {
  it("moves Cinder Shot projectiles and applies server-owned damage", () => {
    const state = createArenaState("cinder-test");
    const attacker = addPlayer(state, "attacker", "Ember", 10_000);
    const target = addPlayer(state, "target", "Target", 10_000);
    attacker.x = 4;
    attacker.y = 7;
    target.x = 6;
    target.y = 7;

    applyPlayerInput(attacker, input(1, { primary: true }), 10_000);
    for (let tick = 0; tick < 5; tick += 1) {
      stepArena(state, 10_000 + tick * 34);
    }

    expect(target.health).toBe(88);
    expect(state.projectiles.size).toBe(0);
    expect([...state.effects.values()].some((effect) => effect.type === "cinder-impact")).toBe(
      true,
    );
  });

  it("makes Tide Ring prime Volt Lance bonus damage and stun", () => {
    const state = createArenaState("combo-test");
    const attacker = addPlayer(state, "attacker", "Storm", 20_000);
    const target = addPlayer(state, "target", "Target", 20_000);
    attacker.x = 10;
    attacker.y = 5.5;
    target.x = 11.8;
    target.y = 5.5;

    applyPlayerInput(attacker, input(1, { secondary: true }), 20_000);
    stepArena(state, 20_000);
    expect(target.health).toBe(92);
    expect(target.soakedUntil).toBeGreaterThan(20_000);

    applyPlayerInput(attacker, input(2, { utility: true }), 20_034);
    stepArena(state, 20_034);
    expect(target.health).toBe(54);
    expect(target.soakedUntil).toBe(0);
    expect(target.stunnedUntil).toBeGreaterThan(20_034);
  });

  it("catches up delayed movement and projectile travel with bounded substeps", () => {
    const start = 40_000;
    const delayed = createArenaState("delayed-travel");
    const reference = createArenaState("reference-travel");
    const delayedPlayer = addPlayer(delayed, "player", "Runner", start);
    const referencePlayer = addPlayer(reference, "player", "Runner", start);

    for (const player of [delayedPlayer, referencePlayer]) {
      player.x = 4;
      player.y = 12;
      applyPlayerInput(player, input(1, { primary: true }), start);
    }
    stepArena(delayed, start);
    stepArena(reference, start);

    const delayedProjectile = [...delayed.projectiles.values()][0];
    const referenceProjectile = [...reference.projectiles.values()][0];
    if (delayedProjectile === undefined || referenceProjectile === undefined) {
      throw new Error("Expected both simulations to create a projectile");
    }
    const delayedPlayerStartX = delayedPlayer.x;
    const delayedProjectileStartX = delayedProjectile.x;

    applyPlayerInput(delayedPlayer, input(2, { moveX: 1 }), start);
    applyPlayerInput(referencePlayer, input(2, { moveX: 1 }), start);
    stepArena(delayed, start + 3 * TICK_INTERVAL_MS, 3 * TICK_INTERVAL_MS);
    for (let tick = 1; tick <= 3; tick += 1) {
      stepArena(reference, start + tick * TICK_INTERVAL_MS);
    }

    expect(delayedPlayer.x - delayedPlayerStartX).toBeGreaterThan(0.2);
    expect(delayedPlayer.x).toBeCloseTo(referencePlayer.x, 8);
    expect(delayedProjectile.x - delayedProjectileStartX).toBeCloseTo(1.35, 8);
    expect(delayedProjectile.x).toBeCloseTo(referenceProjectile.x, 8);
  });

  it("caps a long stall at three ticks and consumes a queued cast once", () => {
    const start = 50_000;
    const capped = createArenaState("capped-stall");
    const reference = createArenaState("capped-reference");
    const cappedPlayer = addPlayer(capped, "player", "Caster", start);
    const referencePlayer = addPlayer(reference, "player", "Caster", start);

    for (const player of [cappedPlayer, referencePlayer]) {
      player.x = 4;
      player.y = 12;
    }

    applyPlayerInput(
      cappedPlayer,
      input(1, { moveX: 1, primary: true }),
      start + 1_000,
    );
    applyPlayerInput(
      referencePlayer,
      input(1, { moveX: 1, primary: true }),
      start + 3 * TICK_INTERVAL_MS,
    );

    stepArena(capped, start + 1_000, 1_000);
    stepArena(reference, start + 3 * TICK_INTERVAL_MS, 3 * TICK_INTERVAL_MS);

    expect(cappedPlayer.x).toBeCloseTo(referencePlayer.x, 8);
    expect(capped.projectiles.size).toBe(1);
    expect(capped.nextProjectileId).toBe(2);
    expect(cappedPlayer.input.primaryQueued).toBe(false);
    expect(cappedPlayer.cooldowns.primary).toBe(start + 1_000 + 170);
    expect([...capped.projectiles.values()][0]?.x).toBeCloseTo(
      [...reference.projectiles.values()][0]?.x ?? Number.NaN,
      8,
    );
  });

  it("neutralizes expired movement and drops queued actions before simulation", () => {
    const start = 60_000;
    const state = createArenaState("stale-input");
    const player = addPlayer(state, "player", "Frozen", start);
    player.x = 4;
    player.y = 12;

    applyPlayerInput(
      player,
      input(1, {
        moveX: 1,
        dash: true,
        primary: true,
        secondary: true,
        utility: true,
      }),
      start,
    );

    expect(
      expirePlayerInputIfStale(
        player,
        start + INPUT_FRESHNESS_TIMEOUT_MS - 1,
      ),
    ).toBe(false);
    expect(player.input.moveX).toBe(1);

    stepArena(
      state,
      start + INPUT_FRESHNESS_TIMEOUT_MS,
      TICK_INTERVAL_MS,
    );

    expect(player.input).toEqual({
      moveX: 0,
      moveY: 0,
      dashQueued: false,
      primaryQueued: false,
      secondaryQueued: false,
      utilityQueued: false,
    });
    expect(player.lastInputAt).toBeNull();
    expect(player.x).toBe(4);
    expect(state.projectiles.size).toBe(0);
    expect(state.effects.size).toBe(1);
  });

  it("round-trips enough state for restart recovery", () => {
    const state = createArenaState("recover-test");
    const player = addPlayer(state, "player", "Keeper", 30_000);
    player.kills = 3;
    player.deaths = 2;
    player.x = 9.25;
    player.y = 5.5;
    applyPlayerInput(player, input(7, { moveX: 1, dash: true }), 30_000);
    stepArena(state, 30_000);

    const restored = restoreArenaState(
      "recover-test",
      serializeArenaState(state, 30_010),
      30_010,
    );
    const snapshot = buildSnapshot(restored, 30_010);

    expect(snapshot.tick).toBe(state.tick);
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]).toMatchObject({
      id: "player",
      name: "Keeper",
      kills: 3,
      deaths: 2,
    });
  });
});
