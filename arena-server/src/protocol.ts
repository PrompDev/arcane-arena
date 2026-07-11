export const MAX_PLAYERS = 4;
export const MAX_MESSAGE_BYTES = 2_048;

export interface Vec2 {
  x: number;
  y: number;
}

export interface ArenaPillar extends Vec2 {
  r: number;
}

export interface ArenaDescription {
  width: number;
  height: number;
  tickRate: number;
  respawnMs: number;
  pillars: ArenaPillar[];
}

export const COMBAT_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type CombatDirection = (typeof COMBAT_DIRECTIONS)[number];
export type CombatPhase = "idle" | "drawing" | "releasing" | "blocking" | "stunned";
export type WeaponType = "arcane-blade";

export interface InputMessage {
  type: "input";
  seq: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  dash: boolean;
  primary: boolean;
  secondary: boolean;
  utility: boolean;
  attackHeld: boolean;
  blockHeld: boolean;
  feint: boolean;
  combatDirection: CombatDirection;
}

export interface PingMessage {
  type: "ping";
  clientTime: number;
}

export type ClientMessage = InputMessage | PingMessage;

export interface CooldownSnapshot {
  dash: number;
  primary: number;
  secondary: number;
  utility: number;
}

export interface PlayerSnapshot extends Vec2 {
  id: string;
  name: string;
  vx: number;
  vy: number;
  aimX: number;
  aimY: number;
  radius: number;
  health: number;
  maxHealth: number;
  kills: number;
  deaths: number;
  alive: boolean;
  respawnAt: number;
  soakedUntil: number;
  stunnedUntil: number;
  dashUntil: number;
  combatPhase: CombatPhase;
  combatDirection: CombatDirection;
  combatStartedAt: number;
  charge: number;
  weapon: WeaponType;
  cooldowns: CooldownSnapshot;
}

export interface ProjectileSnapshot extends Vec2 {
  id: string;
  ownerId: string;
  spell: "cinder-shot";
  vx: number;
  vy: number;
  radius: number;
  expiresAt: number;
}

export type EffectType =
  | "dash"
  | "cinder-impact"
  | "tide-ring"
  | "volt-lance"
  | "spawn"
  | "death";

export interface EffectSnapshot extends Vec2 {
  id: string;
  type: EffectType;
  ownerId: string;
  x2?: number;
  y2?: number;
  radius?: number;
  createdAt: number;
  expiresAt: number;
}

export interface WelcomeMessage {
  type: "welcome";
  id: string;
  room: string;
  serverTime: number;
  arena: ArenaDescription;
}

export interface SnapshotMessage {
  type: "snapshot";
  tick: number;
  serverTime: number;
  players: PlayerSnapshot[];
  projectiles: ProjectileSnapshot[];
  effects: EffectSnapshot[];
}

export interface PongMessage {
  type: "pong";
  clientTime: number;
  serverTime: number;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | PongMessage;

export interface ConnectionAttachment {
  version: 1;
  playerId: string;
  room: string;
  name: string;
  joinedAt: number;
  lastSeq: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedVector(x: unknown, y: unknown): Vec2 {
  let boundedX = finiteNumber(x);
  let boundedY = finiteNumber(y);
  const magnitude = Math.hypot(boundedX, boundedY);

  if (magnitude > 1) {
    boundedX /= magnitude;
    boundedY /= magnitude;
  }

  return {
    x: clamp(boundedX, -1, 1),
    y: clamp(boundedY, -1, 1),
  };
}

function combatDirection(value: unknown): CombatDirection {
  switch (value) {
    case "up":
    case "down":
    case "left":
    case "right":
      return value;
    default:
      return "up";
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (
    raw.length === 0 ||
    raw.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES
  ) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (value.type === "ping") {
    if (typeof value.clientTime !== "number" || !Number.isFinite(value.clientTime)) {
      return null;
    }

    return {
      type: "ping",
      clientTime: clamp(value.clientTime, 0, Number.MAX_SAFE_INTEGER),
    };
  }

  if (value.type !== "input") {
    return null;
  }

  if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) {
    return null;
  }

  const move = boundedVector(value.moveX, value.moveY);
  const aim = boundedVector(value.aimX, value.aimY);

  return {
    type: "input",
    seq: Math.floor(clamp(value.seq, 0, 2_147_483_647)),
    moveX: move.x,
    moveY: move.y,
    aimX: aim.x,
    aimY: aim.y,
    dash: value.dash === true,
    primary: value.primary === true,
    secondary: value.secondary === true,
    utility: value.utility === true,
    attackHeld: value.attackHeld === true,
    blockHeld: value.blockHeld === true,
    feint: value.feint === true,
    combatDirection: combatDirection(value.combatDirection),
  };
}

export function sanitizeRoom(value: string): string | null {
  if (value.length < 1 || value.length > 48 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  return value;
}

export function sanitizeName(value: string | null): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized.length === 0) {
    return "Mage";
  }

  return Array.from(normalized).slice(0, 24).join("");
}

export function parseConnectionAttachment(value: unknown): ConnectionAttachment | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }

  if (
    typeof value.playerId !== "string" ||
    value.playerId.length < 1 ||
    value.playerId.length > 64 ||
    typeof value.room !== "string" ||
    sanitizeRoom(value.room) === null ||
    typeof value.name !== "string" ||
    typeof value.joinedAt !== "number" ||
    !Number.isFinite(value.joinedAt) ||
    typeof value.lastSeq !== "number" ||
    !Number.isInteger(value.lastSeq)
  ) {
    return null;
  }

  return {
    version: 1,
    playerId: value.playerId,
    room: value.room,
    name: sanitizeName(value.name),
    joinedAt: clamp(value.joinedAt, 0, Number.MAX_SAFE_INTEGER),
    lastSeq: Math.floor(clamp(value.lastSeq, -1, 2_147_483_647)),
  };
}
