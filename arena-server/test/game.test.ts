import { describe, expect, it } from "vitest";

import {
  ARENA_DESCRIPTION,
  INPUT_FRESHNESS_TIMEOUT_MS,
  MELEE_BLOCK_STUN_MS,
  MELEE_HIT_STUN_MS,
  MELEE_MAX_DAMAGE,
  MELEE_MAX_CHARGE_MS,
  MELEE_MIN_DAMAGE,
  MELEE_MIN_DRAW_MS,
  MELEE_RELEASE_HIT_AT_MS,
  TICK_INTERVAL_MS,
  addPlayer,
  applyPlayerInput,
  buildSnapshot,
  createArenaState,
  expirePlayerInputIfStale,
  resetPlayerInput,
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
    attackHeld: false,
    blockHeld: false,
    feint: false,
    combatDirection: "up",
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
      attackHeld: false,
      attackPressedQueued: false,
      attackReleasedQueued: false,
      blockHeld: false,
      feintQueued: false,
      combatDirection: "up",
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
      combatPhase: "idle",
      combatDirection: "up",
      charge: 0,
      weapon: "arcane-blade",
    });
  });

  it("accepts version-one saves and clears volatile combat input on connection restore", () => {
    const start = 65_000;
    const state = createArenaState("legacy-recover");
    const player = addPlayer(state, "player", "Keeper", start);
    applyPlayerInput(player, input(1, { attackHeld: true, blockHeld: true }), start);
    stepArena(state, start);

    const persisted = JSON.parse(serializeArenaState(state, start)) as Record<string, unknown>;
    persisted.schemaVersion = 1;
    const restored = restoreArenaState(
      "legacy-recover",
      JSON.stringify(persisted),
      start + 10,
    );
    const restoredPlayer = restored.players.get("player");
    if (restoredPlayer === undefined) {
      throw new Error("Expected the legacy player to restore");
    }

    expect(restoredPlayer.input.attackHeld).toBe(false);
    expect(restoredPlayer.input.blockHeld).toBe(false);
    resetPlayerInput(restoredPlayer, true, start + 10);
    expect(restoredPlayer.combatPhase).toBe("idle");
    expect(restoredPlayer.input).toMatchObject({
      attackHeld: false,
      blockHeld: false,
      feintQueued: false,
    });
  });

  it("charges sword damage from 20 to 40 and applies a 300 ms hit stun", () => {
    const minimumStart = 70_000;
    const minimumState = createArenaState("minimum-melee");
    const minimumAttacker = addPlayer(minimumState, "attacker", "Blade", minimumStart);
    const minimumTarget = addPlayer(minimumState, "target", "Guard", minimumStart);
    minimumAttacker.x = 4;
    minimumAttacker.y = 7;
    minimumTarget.x = 5.5;
    minimumTarget.y = 7;

    applyPlayerInput(
      minimumAttacker,
      input(1, { attackHeld: true, combatDirection: "up" }),
      minimumStart,
    );
    stepArena(minimumState, minimumStart);
    expect(minimumAttacker.combatPhase).toBe("drawing");

    applyPlayerInput(
      minimumAttacker,
      input(2, { attackHeld: false }),
      minimumStart + 100,
    );
    stepArena(minimumState, minimumStart + 100);
    expect(minimumAttacker.combatPhase).toBe("drawing");
    expect(minimumAttacker.meleeReleaseRequested).toBe(true);

    applyPlayerInput(minimumAttacker, input(3), minimumStart + 300);
    stepArena(minimumState, minimumStart + 300);
    expect(minimumAttacker.combatPhase).toBe("drawing");

    const minimumRelease = minimumStart + MELEE_MIN_DRAW_MS;
    applyPlayerInput(minimumAttacker, input(4), minimumRelease);
    stepArena(minimumState, minimumRelease);
    expect(minimumAttacker.combatPhase).toBe("releasing");
    expect(minimumAttacker.charge).toBe(0);

    applyPlayerInput(minimumAttacker, input(5), minimumRelease + 200);
    stepArena(minimumState, minimumRelease + 200);
    applyPlayerInput(
      minimumAttacker,
      input(6),
      minimumRelease + MELEE_RELEASE_HIT_AT_MS,
    );
    stepArena(minimumState, minimumRelease + MELEE_RELEASE_HIT_AT_MS);

    expect(minimumTarget.health).toBe(100 - MELEE_MIN_DAMAGE);
    expect(minimumTarget.combatPhase).toBe("stunned");
    expect(minimumTarget.stunnedUntil).toBe(
      minimumRelease + MELEE_RELEASE_HIT_AT_MS + MELEE_HIT_STUN_MS,
    );

    const maximumStart = 80_000;
    const maximumState = createArenaState("maximum-melee");
    const maximumAttacker = addPlayer(maximumState, "attacker", "Blade", maximumStart);
    const maximumTarget = addPlayer(maximumState, "target", "Guard", maximumStart);
    maximumAttacker.x = 4;
    maximumAttacker.y = 7;
    maximumTarget.x = 5.5;
    maximumTarget.y = 7;

    applyPlayerInput(maximumAttacker, input(1, { attackHeld: true }), maximumStart);
    stepArena(maximumState, maximumStart);
    applyPlayerInput(
      maximumAttacker,
      input(2, { attackHeld: true }),
      maximumStart + MELEE_MAX_CHARGE_MS - 100,
    );
    stepArena(maximumState, maximumStart + MELEE_MAX_CHARGE_MS - 100);

    const maximumRelease = maximumStart + MELEE_MAX_CHARGE_MS;
    applyPlayerInput(maximumAttacker, input(3, { attackHeld: false }), maximumRelease);
    stepArena(maximumState, maximumRelease);
    expect(maximumAttacker.charge).toBe(1);

    applyPlayerInput(maximumAttacker, input(4), maximumRelease + 200);
    stepArena(maximumState, maximumRelease + 200);
    applyPlayerInput(
      maximumAttacker,
      input(5),
      maximumRelease + MELEE_RELEASE_HIT_AT_MS,
    );
    stepArena(maximumState, maximumRelease + MELEE_RELEASE_HIT_AT_MS);
    expect(maximumTarget.health).toBe(100 - MELEE_MAX_DAMAGE);
  });

  it("requires a facing, mirrored directional block and block-stuns the attacker", () => {
    const start = 90_000;
    const blockedState = createArenaState("directional-block");
    const attacker = addPlayer(blockedState, "attacker", "Blade", start);
    const defender = addPlayer(blockedState, "defender", "Guard", start);
    attacker.x = 4;
    attacker.y = 7;
    defender.x = 5.5;
    defender.y = 7;
    defender.aimX = -1;
    defender.aimY = 0;

    applyPlayerInput(
      attacker,
      input(1, { attackHeld: true, combatDirection: "left" }),
      start,
    );
    applyPlayerInput(
      defender,
      input(1, { blockHeld: true, combatDirection: "right", aimX: -1 }),
      start,
    );
    stepArena(blockedState, start);

    const release = start + MELEE_MIN_DRAW_MS;
    applyPlayerInput(
      attacker,
      input(2, { attackHeld: false, combatDirection: "left" }),
      release,
    );
    applyPlayerInput(
      defender,
      input(2, { blockHeld: true, combatDirection: "right", aimX: -1 }),
      release,
    );
    stepArena(blockedState, release);

    for (const offset of [200, MELEE_RELEASE_HIT_AT_MS]) {
      applyPlayerInput(attacker, input(2 + offset), release + offset);
      applyPlayerInput(
        defender,
        input(2 + offset, {
          blockHeld: true,
          combatDirection: "right",
          aimX: -1,
        }),
        release + offset,
      );
      stepArena(blockedState, release + offset);
    }

    expect(defender.health).toBe(100);
    expect(attacker.combatPhase).toBe("stunned");
    expect(attacker.stunnedUntil).toBe(
      release + MELEE_RELEASE_HIT_AT_MS + MELEE_BLOCK_STUN_MS,
    );

    const mismatchStart = 100_000;
    const mismatchState = createArenaState("direction-mismatch");
    const mismatchAttacker = addPlayer(mismatchState, "attacker", "Blade", mismatchStart);
    const mismatchDefender = addPlayer(mismatchState, "defender", "Guard", mismatchStart);
    mismatchAttacker.x = 4;
    mismatchAttacker.y = 7;
    mismatchDefender.x = 5.5;
    mismatchDefender.y = 7;
    mismatchDefender.aimX = -1;

    applyPlayerInput(
      mismatchAttacker,
      input(1, { attackHeld: true, combatDirection: "left" }),
      mismatchStart,
    );
    applyPlayerInput(
      mismatchDefender,
      input(1, { blockHeld: true, combatDirection: "left", aimX: -1 }),
      mismatchStart,
    );
    stepArena(mismatchState, mismatchStart);
    const mismatchRelease = mismatchStart + MELEE_MIN_DRAW_MS;
    applyPlayerInput(
      mismatchAttacker,
      input(2, { attackHeld: false, combatDirection: "left" }),
      mismatchRelease,
    );
    applyPlayerInput(
      mismatchDefender,
      input(2, { blockHeld: true, combatDirection: "left", aimX: -1 }),
      mismatchRelease,
    );
    stepArena(mismatchState, mismatchRelease);
    applyPlayerInput(mismatchAttacker, input(3), mismatchRelease + 200);
    applyPlayerInput(
      mismatchDefender,
      input(3, { blockHeld: true, combatDirection: "left", aimX: -1 }),
      mismatchRelease + 200,
    );
    stepArena(mismatchState, mismatchRelease + 200);
    applyPlayerInput(mismatchAttacker, input(4), mismatchRelease + MELEE_RELEASE_HIT_AT_MS);
    applyPlayerInput(
      mismatchDefender,
      input(4, { blockHeld: true, combatDirection: "left", aimX: -1 }),
      mismatchRelease + MELEE_RELEASE_HIT_AT_MS,
    );
    stepArena(mismatchState, mismatchRelease + MELEE_RELEASE_HIT_AT_MS);
    expect(mismatchDefender.health).toBe(100 - MELEE_MIN_DAMAGE);
    expect(mismatchDefender.combatPhase).toBe("stunned");
  });

  it("allows draw and early-release feints, enforces cooldown, and deals no phantom hit", () => {
    const drawStart = 110_000;
    const drawState = createArenaState("draw-feint");
    const drawAttacker = addPlayer(drawState, "attacker", "Blade", drawStart);
    applyPlayerInput(drawAttacker, input(1, { attackHeld: true }), drawStart);
    stepArena(drawState, drawStart);
    applyPlayerInput(
      drawAttacker,
      input(2, { attackHeld: true, feint: true }),
      drawStart + 100,
    );
    stepArena(drawState, drawStart + 100);
    expect(drawAttacker.combatPhase).toBe("idle");
    expect(drawAttacker.feintCooldownUntil).toBe(drawStart + 600);

    applyPlayerInput(drawAttacker, input(3, { attackHeld: false }), drawStart + 150);
    stepArena(drawState, drawStart + 150);
    applyPlayerInput(drawAttacker, input(4, { attackHeld: true }), drawStart + 200);
    stepArena(drawState, drawStart + 200);
    applyPlayerInput(
      drawAttacker,
      input(5, { attackHeld: true, feint: true }),
      drawStart + 250,
    );
    stepArena(drawState, drawStart + 250);
    expect(drawAttacker.combatPhase).toBe("drawing");

    const releaseStart = 120_000;
    const releaseState = createArenaState("release-feint");
    const releaseAttacker = addPlayer(releaseState, "attacker", "Blade", releaseStart);
    const releaseTarget = addPlayer(releaseState, "target", "Guard", releaseStart);
    releaseAttacker.x = 4;
    releaseAttacker.y = 7;
    releaseTarget.x = 5.5;
    releaseTarget.y = 7;
    applyPlayerInput(releaseAttacker, input(1, { attackHeld: true }), releaseStart);
    stepArena(releaseState, releaseStart);
    applyPlayerInput(
      releaseAttacker,
      input(2, { attackHeld: false }),
      releaseStart + MELEE_MIN_DRAW_MS,
    );
    stepArena(releaseState, releaseStart + MELEE_MIN_DRAW_MS);
    applyPlayerInput(
      releaseAttacker,
      input(3, { feint: true }),
      releaseStart + MELEE_MIN_DRAW_MS + 200,
    );
    stepArena(releaseState, releaseStart + MELEE_MIN_DRAW_MS + 200);
    expect(releaseAttacker.combatPhase).toBe("idle");
    expect(releaseTarget.health).toBe(100);
    applyPlayerInput(releaseAttacker, input(4), releaseStart + MELEE_MIN_DRAW_MS + 400);
    stepArena(releaseState, releaseStart + MELEE_MIN_DRAW_MS + 400);
    expect(releaseTarget.health).toBe(100);
  });

  it("resolves each release once without duplicate damage on later ticks", () => {
    const start = 130_000;
    const state = createArenaState("single-hit");
    const attacker = addPlayer(state, "attacker", "Blade", start);
    const target = addPlayer(state, "target", "Guard", start);
    attacker.x = 4;
    attacker.y = 7;
    target.x = 5.5;
    target.y = 7;
    applyPlayerInput(attacker, input(1, { attackHeld: true }), start);
    stepArena(state, start);
    const release = start + MELEE_MIN_DRAW_MS;
    applyPlayerInput(attacker, input(2, { attackHeld: false }), release);
    stepArena(state, release);

    for (const [seq, offset] of [
      [3, 200],
      [4, MELEE_RELEASE_HIT_AT_MS],
      [5, MELEE_RELEASE_HIT_AT_MS + 100],
      [6, MELEE_RELEASE_HIT_AT_MS + 200],
    ] as const) {
      applyPlayerInput(attacker, input(seq), release + offset);
      stepArena(state, release + offset);
    }

    expect(target.health).toBe(100 - MELEE_MIN_DAMAGE);
    expect(attacker.meleeHitResolved).toBe(true);
  });

  it("resolves simultaneous lethal trades independently of player insertion order", () => {
    function runTrade(insertionOrder: readonly [string, string]) {
      const start = 140_000;
      const state = createArenaState(`trade-${insertionOrder.join("-")}`);
      for (const id of insertionOrder) {
        addPlayer(state, id, id, start);
      }

      const alpha = state.players.get("alpha");
      const zulu = state.players.get("zulu");
      if (alpha === undefined || zulu === undefined) {
        throw new Error("Expected both trade players");
      }

      alpha.x = 4;
      alpha.y = 7;
      alpha.health = MELEE_MIN_DAMAGE;
      zulu.x = 5.5;
      zulu.y = 7;
      zulu.health = MELEE_MIN_DAMAGE;

      applyPlayerInput(alpha, input(1, { attackHeld: true, aimX: 1 }), start);
      applyPlayerInput(zulu, input(1, { attackHeld: true, aimX: -1 }), start);
      stepArena(state, start);

      const release = start + MELEE_MIN_DRAW_MS;
      applyPlayerInput(alpha, input(2, { attackHeld: false, aimX: 1 }), release);
      applyPlayerInput(zulu, input(2, { attackHeld: false, aimX: -1 }), release);
      stepArena(state, release);

      applyPlayerInput(alpha, input(3, { aimX: 1 }), release + 200);
      applyPlayerInput(zulu, input(3, { aimX: -1 }), release + 200);
      stepArena(state, release + 200);

      const hitAt = release + MELEE_RELEASE_HIT_AT_MS;
      applyPlayerInput(alpha, input(4, { aimX: 1 }), hitAt);
      applyPlayerInput(zulu, input(4, { aimX: -1 }), hitAt);
      stepArena(state, hitAt);

      return [alpha, zulu].map((player) => ({
        id: player.id,
        alive: player.alive,
        health: player.health,
        kills: player.kills,
        deaths: player.deaths,
      }));
    }

    const forward = runTrade(["alpha", "zulu"]);
    const reversed = runTrade(["zulu", "alpha"]);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual([
      { id: "alpha", alive: false, health: 0, kills: 1, deaths: 1 },
      { id: "zulu", alive: false, health: 0, kills: 1, deaths: 1 },
    ]);
  });

  it("locks attack aim when drawing so a release cannot snap 180 degrees", () => {
    const start = 150_000;
    const state = createArenaState("locked-melee-aim");
    const attacker = addPlayer(state, "attacker", "Blade", start);
    const rightTarget = addPlayer(state, "right-target", "Right", start);
    const leftTarget = addPlayer(state, "left-target", "Left", start);
    attacker.x = 4;
    attacker.y = 7;
    rightTarget.x = 5.5;
    rightTarget.y = 7;
    leftTarget.x = 2.5;
    leftTarget.y = 7;

    applyPlayerInput(attacker, input(1, { attackHeld: true, aimX: 1 }), start);
    stepArena(state, start);
    expect(attacker.meleeAimX).toBe(1);

    const release = start + MELEE_MIN_DRAW_MS;
    applyPlayerInput(attacker, input(2, { attackHeld: false, aimX: -1 }), release);
    stepArena(state, release);
    applyPlayerInput(attacker, input(3, { aimX: -1 }), release + 200);
    stepArena(state, release + 200);
    const hitAt = release + MELEE_RELEASE_HIT_AT_MS;
    applyPlayerInput(attacker, input(4, { aimX: -1 }), hitAt);
    stepArena(state, hitAt);

    expect(attacker.aimX).toBe(-1);
    expect(rightTarget.health).toBe(100 - MELEE_MIN_DAMAGE);
    expect(leftTarget.health).toBe(100);
  });

  it("blocks melee strikes whose path crosses an arena pillar", () => {
    const start = 160_000;
    const state = createArenaState("pillar-blocked-melee");
    const attacker = addPlayer(state, "attacker", "Blade", start);
    const target = addPlayer(state, "target", "Guard", start);
    const pillar = ARENA_DESCRIPTION.pillars[0];
    if (pillar === undefined) {
      throw new Error("Expected the arena to have a pillar");
    }

    attacker.x = pillar.x - pillar.r - 0.38;
    attacker.y = pillar.y;
    target.x = pillar.x + pillar.r + 0.38;
    target.y = pillar.y;

    applyPlayerInput(attacker, input(1, { attackHeld: true, aimX: 1 }), start);
    stepArena(state, start);
    const release = start + MELEE_MIN_DRAW_MS;
    applyPlayerInput(attacker, input(2, { attackHeld: false, aimX: 1 }), release);
    stepArena(state, release);
    applyPlayerInput(attacker, input(3, { aimX: 1 }), release + 200);
    stepArena(state, release + 200);
    const hitAt = release + MELEE_RELEASE_HIT_AT_MS;
    applyPlayerInput(attacker, input(4, { aimX: 1 }), hitAt);
    stepArena(state, hitAt);

    expect(attacker.meleeHitResolved).toBe(true);
    expect(target.health).toBe(100);
  });
});
