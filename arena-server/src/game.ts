import {
  type ArenaDescription,
  type EffectSnapshot,
  type EffectType,
  type InputMessage,
  type PlayerSnapshot,
  type ProjectileSnapshot,
  type SnapshotMessage,
  isRecord,
  sanitizeName,
} from "./protocol";

export const TICK_RATE = 30;
export const TICK_INTERVAL_MS = 1_000 / TICK_RATE;
export const INPUT_FRESHNESS_TIMEOUT_MS = 250;
export const RESPAWN_MS = 1_700;
export const PERSIST_EVERY_TICKS = 15;

const ARENA_WIDTH = 24;
const ARENA_HEIGHT = 14;
const PLAYER_RADIUS = 0.34;
const MAX_HEALTH = 100;
const MOVE_SPEED = 6.2;
const MOVE_ACCELERATION = 36;
const MOVE_FRICTION = 30;
const DASH_SPEED = 14.2;
const DASH_DURATION_MS = 145;
const DASH_COOLDOWN_MS = 720;
const CINDER_COOLDOWN_MS = 170;
const CINDER_SPEED = 13.5;
const CINDER_DAMAGE = 12;
const CINDER_LIFETIME_MS = 1_000;
const TIDE_COOLDOWN_MS = 2_300;
const TIDE_RADIUS = 2.45;
const TIDE_DAMAGE = 8;
const TIDE_PUSH_SPEED = 8.5;
const SOAKED_DURATION_MS = 4_000;
const VOLT_COOLDOWN_MS = 1_350;
const VOLT_RANGE = 6.6;
const VOLT_HALF_WIDTH = 0.34;
const VOLT_DAMAGE = 20;
const VOLT_SOAKED_BONUS = 18;
const VOLT_STUN_MS = 650;
const MAX_CATCH_UP_STEPS = 3;
const MAX_CATCH_UP_MS = TICK_INTERVAL_MS * MAX_CATCH_UP_STEPS;
const PERSISTENCE_VERSION = 1;

export const ARENA_DESCRIPTION: ArenaDescription = {
  width: ARENA_WIDTH,
  height: ARENA_HEIGHT,
  tickRate: TICK_RATE,
  respawnMs: RESPAWN_MS,
  pillars: [
    { x: 7.2, y: 3.7, r: 0.72 },
    { x: 16.8, y: 3.7, r: 0.72 },
    { x: 12, y: 7, r: 0.9 },
    { x: 7.2, y: 10.3, r: 0.72 },
    { x: 16.8, y: 10.3, r: 0.72 },
  ],
};

const SPAWN_POINTS = [
  { x: 2.6, y: 2.6 },
  { x: 21.4, y: 11.4 },
  { x: 21.4, y: 2.6 },
  { x: 2.6, y: 11.4 },
];

interface PlayerInputState {
  moveX: number;
  moveY: number;
  dashQueued: boolean;
  primaryQueued: boolean;
  secondaryQueued: boolean;
  utilityQueued: boolean;
}

export interface PlayerState extends PlayerSnapshot {
  input: PlayerInputState;
  lastInputAt: number | null;
  lastSeq: number;
}

export interface ProjectileState extends ProjectileSnapshot {}

export interface EffectState extends EffectSnapshot {}

export interface ArenaState {
  room: string;
  tick: number;
  players: Map<string, PlayerState>;
  projectiles: Map<string, ProjectileState>;
  effects: Map<string, EffectState>;
  nextProjectileId: number;
  nextEffectId: number;
}

interface PersistedArenaState {
  schemaVersion: number;
  room: string;
  tick: number;
  savedAt: number;
  nextProjectileId: number;
  nextEffectId: number;
  players: PlayerState[];
  projectiles: ProjectileState[];
  effects: EffectState[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return clamp(finite(value, fallback), minimum, maximum);
}

function safeInteger(value: unknown, fallback = 0): number {
  return Math.floor(boundedNumber(value, fallback, 0, Number.MAX_SAFE_INTEGER));
}

function safeTime(value: unknown): number {
  return boundedNumber(value, 0, 0, Number.MAX_SAFE_INTEGER);
}

function emptyInput(): PlayerInputState {
  return {
    moveX: 0,
    moveY: 0,
    dashQueued: false,
    primaryQueued: false,
    secondaryQueued: false,
    utilityQueued: false,
  };
}

function chooseSpawn(state: ArenaState, excludedPlayerId?: string): { x: number; y: number } {
  let bestPoint = SPAWN_POINTS[0] ?? { x: 2.6, y: 2.6 };
  let bestDistance = -1;

  for (const point of SPAWN_POINTS) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const player of state.players.values()) {
      if (!player.alive || player.id === excludedPlayerId) {
        continue;
      }
      nearest = Math.min(nearest, Math.hypot(point.x - player.x, point.y - player.y));
    }

    if (nearest > bestDistance) {
      bestDistance = nearest;
      bestPoint = point;
    }
  }

  return bestPoint;
}

export function createArenaState(room: string): ArenaState {
  return {
    room,
    tick: 0,
    players: new Map(),
    projectiles: new Map(),
    effects: new Map(),
    nextProjectileId: 1,
    nextEffectId: 1,
  };
}

export function addPlayer(
  state: ArenaState,
  id: string,
  name: string,
  now: number,
): PlayerState {
  const existing = state.players.get(id);
  if (existing !== undefined) {
    existing.name = sanitizeName(name);
    return existing;
  }

  const spawn = chooseSpawn(state);
  const player: PlayerState = {
    id,
    name: sanitizeName(name),
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    aimX: 1,
    aimY: 0,
    radius: PLAYER_RADIUS,
    health: MAX_HEALTH,
    maxHealth: MAX_HEALTH,
    kills: 0,
    deaths: 0,
    alive: true,
    respawnAt: 0,
    soakedUntil: 0,
    stunnedUntil: 0,
    dashUntil: 0,
    cooldowns: {
      dash: now,
      primary: now,
      secondary: now,
      utility: now,
    },
    input: emptyInput(),
    lastInputAt: null,
    lastSeq: -1,
  };

  state.players.set(id, player);
  addEffect(state, "spawn", id, player.x, player.y, now, 520, player.radius * 3);
  return player;
}

export function removePlayer(state: ArenaState, id: string): void {
  state.players.delete(id);

  for (const [projectileId, projectile] of state.projectiles) {
    if (projectile.ownerId === id) {
      state.projectiles.delete(projectileId);
    }
  }
}

export function applyPlayerInput(
  player: PlayerState,
  input: InputMessage,
  receivedAt: number,
): boolean {
  if (input.seq <= player.lastSeq) {
    return false;
  }

  player.lastSeq = input.seq;
  player.lastInputAt = receivedAt;
  player.input.moveX = input.moveX;
  player.input.moveY = input.moveY;

  if (Math.hypot(input.aimX, input.aimY) > 0.01) {
    player.aimX = input.aimX;
    player.aimY = input.aimY;
  }

  player.input.dashQueued ||= input.dash;
  player.input.primaryQueued ||= input.primary;
  player.input.secondaryQueued ||= input.secondary;
  player.input.utilityQueued ||= input.utility;
  return true;
}

export function expirePlayerInputIfStale(player: PlayerState, now: number): boolean {
  if (
    player.lastInputAt === null ||
    now - player.lastInputAt < INPUT_FRESHNESS_TIMEOUT_MS
  ) {
    return false;
  }

  player.input = emptyInput();
  player.lastInputAt = null;
  return true;
}

function nextProjectileId(state: ArenaState): string {
  const id = `p${state.tick.toString(36)}-${state.nextProjectileId.toString(36)}`;
  state.nextProjectileId += 1;
  return id;
}

function nextEffectId(state: ArenaState): string {
  const id = `e${state.tick.toString(36)}-${state.nextEffectId.toString(36)}`;
  state.nextEffectId += 1;
  return id;
}

function addEffect(
  state: ArenaState,
  type: EffectType,
  ownerId: string,
  x: number,
  y: number,
  now: number,
  durationMs: number,
  radius?: number,
  x2?: number,
  y2?: number,
): void {
  const id = nextEffectId(state);
  const effect: EffectState = {
    id,
    type,
    ownerId,
    x,
    y,
    createdAt: now,
    expiresAt: now + durationMs,
  };

  if (radius !== undefined) {
    effect.radius = radius;
  }
  if (x2 !== undefined) {
    effect.x2 = x2;
  }
  if (y2 !== undefined) {
    effect.y2 = y2;
  }

  state.effects.set(id, effect);
}

function normalizedDirection(x: number, y: number, fallbackX = 1, fallbackY = 0): {
  x: number;
  y: number;
} {
  const magnitude = Math.hypot(x, y);
  if (magnitude < 0.001) {
    return { x: fallbackX, y: fallbackY };
  }
  return { x: x / magnitude, y: y / magnitude };
}

function approach(current: number, target: number, maximumDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maximumDelta) {
    return target;
  }
  return current + Math.sign(delta) * maximumDelta;
}

function resolveArenaCollision(player: PlayerState): void {
  player.x = clamp(player.x, player.radius, ARENA_WIDTH - player.radius);
  player.y = clamp(player.y, player.radius, ARENA_HEIGHT - player.radius);

  for (const pillar of ARENA_DESCRIPTION.pillars) {
    const dx = player.x - pillar.x;
    const dy = player.y - pillar.y;
    const minimumDistance = player.radius + pillar.r;
    const distance = Math.hypot(dx, dy);

    if (distance >= minimumDistance) {
      continue;
    }

    const normal = normalizedDirection(dx, dy, 1, 0);
    player.x = pillar.x + normal.x * minimumDistance;
    player.y = pillar.y + normal.y * minimumDistance;

    const inwardVelocity = player.vx * normal.x + player.vy * normal.y;
    if (inwardVelocity < 0) {
      player.vx -= inwardVelocity * normal.x;
      player.vy -= inwardVelocity * normal.y;
    }
  }
}

function resolvePlayerCollisions(state: ArenaState): void {
  const players = [...state.players.values()].filter((player) => player.alive);

  for (let firstIndex = 0; firstIndex < players.length; firstIndex += 1) {
    const first = players[firstIndex];
    if (first === undefined) {
      continue;
    }

    for (let secondIndex = firstIndex + 1; secondIndex < players.length; secondIndex += 1) {
      const second = players[secondIndex];
      if (second === undefined) {
        continue;
      }

      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const minimumDistance = first.radius + second.radius;
      const distance = Math.hypot(dx, dy);
      if (distance >= minimumDistance) {
        continue;
      }

      const normal = normalizedDirection(dx, dy, 1, 0);
      const correction = (minimumDistance - distance) / 2;
      first.x -= normal.x * correction;
      first.y -= normal.y * correction;
      second.x += normal.x * correction;
      second.y += normal.y * correction;
      resolveArenaCollision(first);
      resolveArenaCollision(second);
    }
  }
}

function beginDash(state: ArenaState, player: PlayerState, now: number): void {
  if (!player.input.dashQueued || now < player.cooldowns.dash || now < player.stunnedUntil) {
    return;
  }

  const movementMagnitude = Math.hypot(player.input.moveX, player.input.moveY);
  const direction =
    movementMagnitude > 0.01
      ? normalizedDirection(player.input.moveX, player.input.moveY)
      : normalizedDirection(player.aimX, player.aimY);

  player.vx = direction.x * DASH_SPEED;
  player.vy = direction.y * DASH_SPEED;
  player.dashUntil = now + DASH_DURATION_MS;
  player.cooldowns.dash = now + DASH_COOLDOWN_MS;
  addEffect(
    state,
    "dash",
    player.id,
    player.x,
    player.y,
    now,
    240,
    player.radius,
    player.x + direction.x * 1.4,
    player.y + direction.y * 1.4,
  );
}

function castCinderShot(state: ArenaState, player: PlayerState, now: number): void {
  if (!player.input.primaryQueued || now < player.cooldowns.primary) {
    return;
  }

  const direction = normalizedDirection(player.aimX, player.aimY);
  const radius = 0.16;
  const id = nextProjectileId(state);
  state.projectiles.set(id, {
    id,
    ownerId: player.id,
    spell: "cinder-shot",
    x: player.x + direction.x * (player.radius + radius + 0.05),
    y: player.y + direction.y * (player.radius + radius + 0.05),
    vx: direction.x * CINDER_SPEED,
    vy: direction.y * CINDER_SPEED,
    radius,
    expiresAt: now + CINDER_LIFETIME_MS,
  });
  player.cooldowns.primary = now + CINDER_COOLDOWN_MS;
}

function applyDamage(
  state: ArenaState,
  target: PlayerState,
  attackerId: string,
  damage: number,
  now: number,
): void {
  if (!target.alive) {
    return;
  }

  target.health = Math.max(0, target.health - damage);
  if (target.health > 0) {
    return;
  }

  target.alive = false;
  target.deaths += 1;
  target.respawnAt = now + RESPAWN_MS;
  target.vx = 0;
  target.vy = 0;
  target.dashUntil = 0;
  target.soakedUntil = 0;
  target.stunnedUntil = 0;
  target.input = emptyInput();

  const attacker = state.players.get(attackerId);
  if (attacker !== undefined && attacker.id !== target.id) {
    attacker.kills += 1;
  }

  addEffect(state, "death", target.id, target.x, target.y, now, 620, target.radius * 2.8);
}

function castTideRing(state: ArenaState, player: PlayerState, now: number): void {
  if (!player.input.secondaryQueued || now < player.cooldowns.secondary) {
    return;
  }

  player.cooldowns.secondary = now + TIDE_COOLDOWN_MS;
  addEffect(state, "tide-ring", player.id, player.x, player.y, now, 620, TIDE_RADIUS);

  for (const target of state.players.values()) {
    if (!target.alive || target.id === player.id) {
      continue;
    }

    const dx = target.x - player.x;
    const dy = target.y - player.y;
    if (Math.hypot(dx, dy) > TIDE_RADIUS + target.radius) {
      continue;
    }

    const direction = normalizedDirection(dx, dy, player.aimX, player.aimY);
    target.vx += direction.x * TIDE_PUSH_SPEED;
    target.vy += direction.y * TIDE_PUSH_SPEED;
    target.soakedUntil = now + SOAKED_DURATION_MS;
    applyDamage(state, target, player.id, TIDE_DAMAGE, now);
  }
}

function rayCircleHitDistance(
  originX: number,
  originY: number,
  directionX: number,
  directionY: number,
  circleX: number,
  circleY: number,
  radius: number,
): number | null {
  const offsetX = originX - circleX;
  const offsetY = originY - circleY;
  const along = offsetX * directionX + offsetY * directionY;
  const c = offsetX * offsetX + offsetY * offsetY - radius * radius;
  const discriminant = along * along - c;

  if (discriminant < 0) {
    return null;
  }

  const near = -along - Math.sqrt(discriminant);
  if (near >= 0) {
    return near;
  }

  const far = -along + Math.sqrt(discriminant);
  return far >= 0 ? far : null;
}

function castVoltLance(state: ArenaState, player: PlayerState, now: number): void {
  if (!player.input.utilityQueued || now < player.cooldowns.utility) {
    return;
  }

  player.cooldowns.utility = now + VOLT_COOLDOWN_MS;
  const direction = normalizedDirection(player.aimX, player.aimY);
  let maximumDistance = VOLT_RANGE;

  for (const pillar of ARENA_DESCRIPTION.pillars) {
    const hitDistance = rayCircleHitDistance(
      player.x,
      player.y,
      direction.x,
      direction.y,
      pillar.x,
      pillar.y,
      pillar.r + 0.08,
    );
    if (hitDistance !== null) {
      maximumDistance = Math.min(maximumDistance, hitDistance);
    }
  }

  let hitTarget: PlayerState | null = null;
  let hitDistance = maximumDistance;
  for (const target of state.players.values()) {
    if (!target.alive || target.id === player.id) {
      continue;
    }

    const targetDistance = rayCircleHitDistance(
      player.x,
      player.y,
      direction.x,
      direction.y,
      target.x,
      target.y,
      target.radius + VOLT_HALF_WIDTH,
    );
    if (targetDistance !== null && targetDistance <= hitDistance) {
      hitDistance = targetDistance;
      hitTarget = target;
    }
  }

  const endX = player.x + direction.x * hitDistance;
  const endY = player.y + direction.y * hitDistance;
  addEffect(
    state,
    "volt-lance",
    player.id,
    player.x,
    player.y,
    now,
    260,
    VOLT_HALF_WIDTH,
    endX,
    endY,
  );

  if (hitTarget === null) {
    return;
  }

  const wasSoaked = hitTarget.soakedUntil > now;
  if (wasSoaked) {
    hitTarget.soakedUntil = 0;
    hitTarget.stunnedUntil = Math.max(hitTarget.stunnedUntil, now + VOLT_STUN_MS);
  }

  applyDamage(
    state,
    hitTarget,
    player.id,
    VOLT_DAMAGE + (wasSoaked ? VOLT_SOAKED_BONUS : 0),
    now,
  );
}

function movePlayer(player: PlayerState, now: number, deltaSeconds: number): void {
  if (now < player.dashUntil) {
    player.x += player.vx * deltaSeconds;
    player.y += player.vy * deltaSeconds;
    resolveArenaCollision(player);
    return;
  }

  const stunned = now < player.stunnedUntil;
  const movement = stunned
    ? { x: 0, y: 0 }
    : normalizedDirection(player.input.moveX, player.input.moveY, 0, 0);
  const hasMovement = !stunned && Math.hypot(player.input.moveX, player.input.moveY) > 0.01;
  const targetX = hasMovement ? movement.x * MOVE_SPEED : 0;
  const targetY = hasMovement ? movement.y * MOVE_SPEED : 0;
  const rate = hasMovement ? MOVE_ACCELERATION : MOVE_FRICTION;

  player.vx = approach(player.vx, targetX, rate * deltaSeconds);
  player.vy = approach(player.vy, targetY, rate * deltaSeconds);
  player.x += player.vx * deltaSeconds;
  player.y += player.vy * deltaSeconds;
  resolveArenaCollision(player);
}

function projectileHitsPillar(projectile: ProjectileState): boolean {
  return ARENA_DESCRIPTION.pillars.some(
    (pillar) =>
      Math.hypot(projectile.x - pillar.x, projectile.y - pillar.y) <=
      projectile.radius + pillar.r,
  );
}

function stepProjectiles(state: ArenaState, now: number, deltaSeconds: number): void {
  for (const [id, projectile] of state.projectiles) {
    if (projectile.expiresAt <= now) {
      state.projectiles.delete(id);
      continue;
    }

    projectile.x += projectile.vx * deltaSeconds;
    projectile.y += projectile.vy * deltaSeconds;

    const outsideArena =
      projectile.x < projectile.radius ||
      projectile.x > ARENA_WIDTH - projectile.radius ||
      projectile.y < projectile.radius ||
      projectile.y > ARENA_HEIGHT - projectile.radius;

    if (outsideArena || projectileHitsPillar(projectile)) {
      addEffect(
        state,
        "cinder-impact",
        projectile.ownerId,
        projectile.x,
        projectile.y,
        now,
        300,
        0.48,
      );
      state.projectiles.delete(id);
      continue;
    }

    let hit = false;
    for (const target of state.players.values()) {
      if (!target.alive || target.id === projectile.ownerId) {
        continue;
      }

      if (
        Math.hypot(projectile.x - target.x, projectile.y - target.y) >
        projectile.radius + target.radius
      ) {
        continue;
      }

      applyDamage(state, target, projectile.ownerId, CINDER_DAMAGE, now);
      addEffect(
        state,
        "cinder-impact",
        projectile.ownerId,
        projectile.x,
        projectile.y,
        now,
        340,
        0.58,
      );
      state.projectiles.delete(id);
      hit = true;
      break;
    }

    if (hit) {
      continue;
    }
  }
}

function respawnPlayer(state: ArenaState, player: PlayerState, now: number): void {
  const spawn = chooseSpawn(state, player.id);
  player.x = spawn.x;
  player.y = spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.health = player.maxHealth;
  player.alive = true;
  player.respawnAt = 0;
  player.soakedUntil = 0;
  player.stunnedUntil = 0;
  player.dashUntil = 0;
  player.cooldowns = {
    dash: now,
    primary: now,
    secondary: now,
    utility: now,
  };
  player.input = emptyInput();
  addEffect(state, "spawn", player.id, player.x, player.y, now, 520, player.radius * 3);
}

export function stepArena(
  state: ArenaState,
  now: number,
  elapsedMs = TICK_INTERVAL_MS,
): void {
  state.tick += 1;

  const boundedElapsedMs = boundedNumber(
    elapsedMs,
    TICK_INTERVAL_MS,
    0,
    MAX_CATCH_UP_MS,
  );
  const substepCount = Math.max(
    1,
    Math.ceil(boundedElapsedMs / TICK_INTERVAL_MS),
  );
  const substepMs = boundedElapsedMs / substepCount;
  const deltaSeconds = substepMs / 1_000;
  const integrationStartedAt = now - boundedElapsedMs;

  for (let substep = 0; substep < substepCount; substep += 1) {
    const substepNow =
      substep === substepCount - 1
        ? now
        : integrationStartedAt + substepMs * (substep + 1);
    const processQueuedActions = substep === substepCount - 1;

    for (const [effectId, effect] of state.effects) {
      if (effect.expiresAt <= substepNow) {
        state.effects.delete(effectId);
      }
    }

    for (const player of state.players.values()) {
      expirePlayerInputIfStale(player, substepNow);

      if (!player.alive) {
        if (player.respawnAt > 0 && substepNow >= player.respawnAt) {
          respawnPlayer(state, player, substepNow);
        }
        continue;
      }

      if (player.soakedUntil <= substepNow) {
        player.soakedUntil = 0;
      }
      if (player.stunnedUntil <= substepNow) {
        player.stunnedUntil = 0;
      }

      if (processQueuedActions) {
        beginDash(state, player, substepNow);
        if (substepNow >= player.stunnedUntil) {
          castCinderShot(state, player, substepNow);
          castTideRing(state, player, substepNow);
          castVoltLance(state, player, substepNow);
        }
      }
      movePlayer(player, substepNow, deltaSeconds);

      if (processQueuedActions) {
        player.input.dashQueued = false;
        player.input.primaryQueued = false;
        player.input.secondaryQueued = false;
        player.input.utilityQueued = false;
      }
    }

    resolvePlayerCollisions(state);
    stepProjectiles(state, substepNow, deltaSeconds);
  }
}

function playerSnapshot(player: PlayerState): PlayerSnapshot {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    aimX: player.aimX,
    aimY: player.aimY,
    radius: player.radius,
    health: player.health,
    maxHealth: player.maxHealth,
    kills: player.kills,
    deaths: player.deaths,
    alive: player.alive,
    respawnAt: player.respawnAt,
    soakedUntil: player.soakedUntil,
    stunnedUntil: player.stunnedUntil,
    dashUntil: player.dashUntil,
    cooldowns: { ...player.cooldowns },
  };
}

export function buildSnapshot(state: ArenaState, now: number): SnapshotMessage {
  return {
    type: "snapshot",
    tick: state.tick,
    serverTime: now,
    players: [...state.players.values()]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map(playerSnapshot),
    projectiles: [...state.projectiles.values()]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((projectile) => ({ ...projectile })),
    effects: [...state.effects.values()]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((effect) => ({ ...effect })),
  };
}

export function serializeArenaState(state: ArenaState, now: number): string {
  const persisted: PersistedArenaState = {
    schemaVersion: PERSISTENCE_VERSION,
    room: state.room,
    tick: state.tick,
    savedAt: now,
    nextProjectileId: state.nextProjectileId,
    nextEffectId: state.nextEffectId,
    players: [...state.players.values()],
    projectiles: [...state.projectiles.values()],
    effects: [...state.effects.values()],
  };
  return JSON.stringify(persisted);
}

function restorePlayer(value: unknown): PlayerState | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }

  const cooldowns = isRecord(value.cooldowns) ? value.cooldowns : {};
  const aim = normalizedDirection(finite(value.aimX, 1), finite(value.aimY), 1, 0);
  const maxHealth = boundedNumber(value.maxHealth, MAX_HEALTH, 1, MAX_HEALTH);
  return {
    id: value.id.slice(0, 64),
    name: sanitizeName(typeof value.name === "string" ? value.name : null),
    x: boundedNumber(value.x, 2.6, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS),
    y: boundedNumber(value.y, 2.6, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS),
    vx: boundedNumber(value.vx, 0, -DASH_SPEED * 2, DASH_SPEED * 2),
    vy: boundedNumber(value.vy, 0, -DASH_SPEED * 2, DASH_SPEED * 2),
    aimX: aim.x,
    aimY: aim.y,
    radius: PLAYER_RADIUS,
    health: boundedNumber(value.health, maxHealth, 0, maxHealth),
    maxHealth,
    kills: safeInteger(value.kills),
    deaths: safeInteger(value.deaths),
    alive: value.alive === true,
    respawnAt: safeTime(value.respawnAt),
    soakedUntil: safeTime(value.soakedUntil),
    stunnedUntil: safeTime(value.stunnedUntil),
    dashUntil: safeTime(value.dashUntil),
    cooldowns: {
      dash: safeTime(cooldowns.dash),
      primary: safeTime(cooldowns.primary),
      secondary: safeTime(cooldowns.secondary),
      utility: safeTime(cooldowns.utility),
    },
    input: emptyInput(),
    lastInputAt: null,
    lastSeq: Math.floor(boundedNumber(value.lastSeq, -1, -1, 2_147_483_647)),
  };
}

function restoreProjectile(value: unknown, now: number): ProjectileState | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.ownerId !== "string" ||
    value.spell !== "cinder-shot"
  ) {
    return null;
  }

  const expiresAt = safeTime(value.expiresAt);
  if (expiresAt <= now) {
    return null;
  }

  return {
    id: value.id.slice(0, 96),
    ownerId: value.ownerId.slice(0, 64),
    spell: "cinder-shot",
    x: boundedNumber(value.x, 0, -1, ARENA_WIDTH + 1),
    y: boundedNumber(value.y, 0, -1, ARENA_HEIGHT + 1),
    vx: boundedNumber(value.vx, 0, -CINDER_SPEED, CINDER_SPEED),
    vy: boundedNumber(value.vy, 0, -CINDER_SPEED, CINDER_SPEED),
    radius: boundedNumber(value.radius, 0.16, 0.05, 0.5),
    expiresAt,
  };
}

const EFFECT_TYPES: ReadonlySet<string> = new Set([
  "dash",
  "cinder-impact",
  "tide-ring",
  "volt-lance",
  "spawn",
  "death",
]);

function restoreEffect(value: unknown, now: number): EffectState | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.type !== "string" ||
    !EFFECT_TYPES.has(value.type)
  ) {
    return null;
  }

  const expiresAt = safeTime(value.expiresAt);
  if (expiresAt <= now) {
    return null;
  }

  const effect: EffectState = {
    id: value.id.slice(0, 96),
    type: effectType(value.type),
    ownerId: value.ownerId.slice(0, 64),
    x: boundedNumber(value.x, 0, -2, ARENA_WIDTH + 2),
    y: boundedNumber(value.y, 0, -2, ARENA_HEIGHT + 2),
    createdAt: safeTime(value.createdAt),
    expiresAt,
  };

  if (typeof value.radius === "number" && Number.isFinite(value.radius)) {
    effect.radius = clamp(value.radius, 0, 10);
  }
  if (typeof value.x2 === "number" && Number.isFinite(value.x2)) {
    effect.x2 = clamp(value.x2, -2, ARENA_WIDTH + 2);
  }
  if (typeof value.y2 === "number" && Number.isFinite(value.y2)) {
    effect.y2 = clamp(value.y2, -2, ARENA_HEIGHT + 2);
  }
  return effect;
}

function effectType(value: string): EffectType {
  switch (value) {
    case "dash":
    case "cinder-impact":
    case "tide-ring":
    case "volt-lance":
    case "spawn":
    case "death":
      return value;
    default:
      return "spawn";
  }
}

export function restoreArenaState(room: string, raw: string, now: number): ArenaState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return createArenaState(room);
  }

  if (!isRecord(value) || value.schemaVersion !== PERSISTENCE_VERSION) {
    return createArenaState(room);
  }

  const state = createArenaState(room);
  state.tick = safeInteger(value.tick);
  state.nextProjectileId = Math.max(1, safeInteger(value.nextProjectileId, 1));
  state.nextEffectId = Math.max(1, safeInteger(value.nextEffectId, 1));

  if (Array.isArray(value.players)) {
    for (const candidate of value.players) {
      const player = restorePlayer(candidate);
      if (player !== null) {
        state.players.set(player.id, player);
      }
    }
  }

  if (Array.isArray(value.projectiles)) {
    for (const candidate of value.projectiles) {
      const projectile = restoreProjectile(candidate, now);
      if (projectile !== null && state.players.has(projectile.ownerId)) {
        state.projectiles.set(projectile.id, projectile);
      }
    }
  }

  if (Array.isArray(value.effects)) {
    for (const candidate of value.effects) {
      const effect = restoreEffect(candidate, now);
      if (effect !== null) {
        state.effects.set(effect.id, effect);
      }
    }
  }

  return state;
}
