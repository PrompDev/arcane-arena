import type {
  ArenaColor,
  ArenaEffect,
  ArenaFrame,
  ArenaPlayer,
  ArenaProjectile,
  ArenaRenderer,
  ArenaSpellKind,
  ArenaTrailPoint,
} from "./types";

type Color = readonly [red: number, green: number, blue: number, alpha: number];

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  arenaWidth: number;
  arenaHeight: number;
}

interface RectCommand {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: Color;
}

interface CircleCommand {
  kind: "circle";
  x: number;
  y: number;
  radius: number;
  color: Color;
}

interface EllipseCommand {
  kind: "ellipse";
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  color: Color;
}

interface LineCommand {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  color: Color;
  cap: "butt" | "round";
}

interface RingCommand {
  kind: "ring";
  x: number;
  y: number;
  radius: number;
  width: number;
  color: Color;
}

interface PolygonCommand {
  kind: "polygon";
  points: readonly number[];
  color: Color;
}

type DrawCommand =
  | RectCommand
  | CircleCommand
  | EllipseCommand
  | LineCommand
  | RingCommand
  | PolygonCommand;

interface TrailSample {
  x: number;
  y: number;
  time: number;
}

const PALETTE = {
  background: [0.012, 0.016, 0.03, 1] as Color,
  abyss: [0.018, 0.025, 0.05, 1] as Color,
  floor: [0.035, 0.052, 0.09, 1] as Color,
  floorFacet: [0.055, 0.072, 0.12, 0.58] as Color,
  grid: [0.13, 0.22, 0.34, 0.16] as Color,
  gridMajor: [0.2, 0.36, 0.49, 0.22] as Color,
  edgeShadow: [0, 0, 0, 0.72] as Color,
  edge: [0.18, 0.28, 0.42, 0.78] as Color,
  edgeLight: [0.34, 0.63, 0.75, 0.42] as Color,
  pillarShadow: [0, 0, 0, 0.62] as Color,
  pillarOuter: [0.055, 0.07, 0.12, 1] as Color,
  pillarInner: [0.09, 0.11, 0.18, 1] as Color,
  pillarFacet: [0.17, 0.2, 0.29, 0.74] as Color,
  cyan: [0.08, 0.9, 1, 1] as Color,
  magenta: [1, 0.16, 0.68, 1] as Color,
  gold: [1, 0.7, 0.16, 1] as Color,
  blue: [0.24, 0.43, 1, 1] as Color,
  ember: [1, 0.31, 0.1, 1] as Color,
  tide: [0.08, 0.78, 1, 1] as Color,
  volt: [1, 0.84, 0.23, 1] as Color,
  arcane: [0.82, 0.23, 1, 1] as Color,
  white: [0.92, 0.99, 1, 1] as Color,
  black: [0.005, 0.008, 0.018, 1] as Color,
  health: [0.25, 1, 0.61, 1] as Color,
  danger: [1, 0.18, 0.28, 1] as Color,
};

const PLAYER_COLORS = [PALETTE.cyan, PALETTE.magenta, PALETTE.gold, PALETTE.blue] as const;
const MAX_DPR = 2.5;
const MAX_CANVAS_DIMENSION = 4096;
const FLOATS_PER_VERTEX = 6;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function alpha(color: Color, opacity: number): Color {
  return [color[0], color[1], color[2], clamp(color[3] * opacity)];
}

function mix(first: Color, second: Color, amount: number, opacity = 1): Color {
  const t = clamp(amount);
  return [
    first[0] + (second[0] - first[0]) * t,
    first[1] + (second[1] - first[1]) * t,
    first[2] + (second[2] - first[2]) * t,
    clamp((first[3] + (second[3] - first[3]) * t) * opacity),
  ];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function noise(seed: number, index: number): number {
  let value = Math.imul(seed ^ Math.imul(index + 1, 0x45d9f3b), 0x27d4eb2d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return (value >>> 0) / 0xffffffff;
}

function parseColor(input: ArenaColor | undefined, fallback: Color): Color {
  if (!input) return fallback;
  const value = input.trim().toLowerCase();
  const named: Record<string, Color> = {
    cyan: PALETTE.cyan,
    magenta: PALETTE.magenta,
    gold: PALETTE.gold,
    blue: PALETTE.blue,
    ember: PALETTE.ember,
    tide: PALETTE.tide,
    volt: PALETTE.volt,
    arcane: PALETTE.arcane,
  };
  if (named[value]) return named[value];

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (/^[0-9a-f]{3,4}$/i.test(hex)) {
      const channels = [...hex].map((character) => Number.parseInt(character + character, 16) / 255);
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
      return [
        Number.parseInt(hex.slice(0, 2), 16) / 255,
        Number.parseInt(hex.slice(2, 4), 16) / 255,
        Number.parseInt(hex.slice(4, 6), 16) / 255,
        hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }

  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (rgb) {
    return [
      clamp(Number(rgb[1]) / 255),
      clamp(Number(rgb[2]) / 255),
      clamp(Number(rgb[3]) / 255),
      rgb[4] === undefined ? 1 : clamp(Number(rgb[4])),
    ];
  }

  return fallback;
}

function colorToCss(color: Color): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(
    color[2] * 255,
  )}, ${color[3]})`;
}

function spellColor(kind: ArenaSpellKind): Color {
  switch (kind) {
    case "tide":
    case "tide-burst":
      return PALETTE.tide;
    case "volt":
    case "volt-lance":
      return PALETTE.volt;
    case "arcane":
      return PALETTE.arcane;
    case "ember":
    case "cinder-shot":
    default:
      return PALETTE.ember;
  }
}

function playerColor(player: ArenaPlayer): Color {
  const fallback = PLAYER_COLORS[hashString(player.id) % PLAYER_COLORS.length];
  return parseColor(player.color, fallback);
}

function effectKind(effect: ArenaEffect): string {
  return effect.kind ?? effect.type;
}

function projectileKind(projectile: ArenaProjectile): ArenaSpellKind {
  return projectile.kind ?? projectile.spell;
}

function effectProgress(effect: ArenaEffect, now: number): number {
  if (typeof effect.progress === "number") return clamp(effect.progress);
  const createdAt = finite(effect.createdAt, Number.NaN);
  const expiresAt = finite(effect.expiresAt, Number.NaN);
  if (Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > createdAt) {
    return clamp((now - createdAt) / (expiresAt - createdAt));
  }
  const duration = finite(effect.duration, Number.NaN);
  if (Number.isFinite(createdAt) && Number.isFinite(duration) && duration > 0) {
    return clamp((now - createdAt) / duration);
  }
  return 0.36;
}

function syncCanvasSize(canvas: HTMLCanvasElement, previous?: CanvasSize): CanvasSize {
  const rect = canvas.getBoundingClientRect();
  const deviceRatio = clamp(finite(globalThis.devicePixelRatio, 1), 1, MAX_DPR);
  const fallbackWidth = previous ? previous.width / previous.dpr : Math.max(canvas.width, 960);
  const fallbackHeight = previous ? previous.height / previous.dpr : Math.max(canvas.height, 560);
  const cssWidth = Math.max(1, rect.width || canvas.clientWidth || fallbackWidth);
  const cssHeight = Math.max(1, rect.height || canvas.clientHeight || fallbackHeight);
  const width = Math.min(MAX_CANVAS_DIMENSION, Math.max(1, Math.round(cssWidth * deviceRatio)));
  const height = Math.min(MAX_CANVAS_DIMENSION, Math.max(1, Math.round(cssHeight * deviceRatio)));

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  return { width, height, dpr: deviceRatio };
}

function makeViewport(frame: ArenaFrame, size: CanvasSize): Viewport {
  const arenaWidth = Math.max(1, finite(frame.arena.width, 24));
  const arenaHeight = Math.max(1, finite(frame.arena.height, 14));
  const margin = clamp(Math.min(size.width, size.height) * 0.045, 12 * size.dpr, 54 * size.dpr);
  const scale = Math.max(
    1,
    Math.min((size.width - margin * 2) / arenaWidth, (size.height - margin * 2) / arenaHeight),
  );
  const width = arenaWidth * scale;
  const height = arenaHeight * scale;
  return {
    x: (size.width - width) * 0.5,
    y: (size.height - height) * 0.5,
    width,
    height,
    scale,
    arenaWidth,
    arenaHeight,
  };
}

function worldX(viewport: Viewport, x: number): number {
  return viewport.x + finite(x) * viewport.scale;
}

function worldY(viewport: Viewport, y: number): number {
  return viewport.y + finite(y) * viewport.scale;
}

function addRect(
  commands: DrawCommand[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
): void {
  if (width <= 0 || height <= 0 || color[3] <= 0) return;
  commands.push({ kind: "rect", x, y, width, height, color });
}

function addCircle(
  commands: DrawCommand[],
  x: number,
  y: number,
  radius: number,
  color: Color,
): void {
  if (radius <= 0 || color[3] <= 0) return;
  commands.push({ kind: "circle", x, y, radius, color });
}

function addEllipse(
  commands: DrawCommand[],
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  color: Color,
): void {
  if (radiusX <= 0 || radiusY <= 0 || color[3] <= 0) return;
  commands.push({ kind: "ellipse", x, y, radiusX, radiusY, color });
}

function addLine(
  commands: DrawCommand[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: Color,
  cap: "butt" | "round" = "round",
): void {
  if (width <= 0 || color[3] <= 0 || Math.hypot(x2 - x1, y2 - y1) < 0.001) return;
  commands.push({ kind: "line", x1, y1, x2, y2, width, color, cap });
}

function addRing(
  commands: DrawCommand[],
  x: number,
  y: number,
  radius: number,
  width: number,
  color: Color,
): void {
  if (radius <= 0 || width <= 0 || color[3] <= 0) return;
  commands.push({ kind: "ring", x, y, radius, width, color });
}

function addPolygon(commands: DrawCommand[], points: readonly number[], color: Color): void {
  if (points.length < 6 || color[3] <= 0) return;
  commands.push({ kind: "polygon", points, color });
}

class MotionTrails {
  private players = new Map<string, TrailSample[]>();
  private projectiles = new Map<string, TrailSample[]>();
  private lastNow = Number.NEGATIVE_INFINITY;

  update(frame: ArenaFrame): void {
    const now = finite(frame.now, performance.now());
    if (now + 100 < this.lastNow) {
      this.clear();
    }
    this.lastNow = now;

    const livePlayers = new Set<string>();
    for (const player of frame.players) {
      livePlayers.add(player.id);
      const speed = Math.hypot(finite(player.vx), finite(player.vy));
      const dashing =
        player.isDashing === true || finite(player.dashUntil, Number.NEGATIVE_INFINITY) > now || speed > 7;
      this.record(this.players, player.id, player.x, player.y, now, dashing, 280, 0.05);
    }
    this.pruneMissing(this.players, livePlayers, now, 280);

    const liveProjectiles = new Set<string>();
    for (const projectile of frame.projectiles) {
      liveProjectiles.add(projectile.id);
      this.record(this.projectiles, projectile.id, projectile.x, projectile.y, now, true, 180, 0.025);
    }
    this.pruneMissing(this.projectiles, liveProjectiles, now, 180);
  }

  playerTrail(id: string): readonly TrailSample[] {
    return this.players.get(id) ?? [];
  }

  projectileTrail(id: string): readonly TrailSample[] {
    return this.projectiles.get(id) ?? [];
  }

  clear(): void {
    this.players.clear();
    this.projectiles.clear();
  }

  private record(
    store: Map<string, TrailSample[]>,
    id: string,
    xValue: number,
    yValue: number,
    now: number,
    active: boolean,
    lifetime: number,
    minimumDistance: number,
  ): void {
    const x = finite(xValue);
    const y = finite(yValue);
    const samples = store.get(id) ?? [];
    while (samples.length > 0 && now - samples[0].time > lifetime) samples.shift();
    const previous = samples[samples.length - 1];
    if (
      active &&
      (!previous ||
        now !== previous.time ||
        Math.hypot(x - previous.x, y - previous.y) >= minimumDistance)
    ) {
      if (!previous || Math.hypot(x - previous.x, y - previous.y) >= minimumDistance) {
        samples.push({ x, y, time: now });
      }
    }
    if (samples.length > 18) samples.splice(0, samples.length - 18);
    if (samples.length > 0) store.set(id, samples);
  }

  private pruneMissing(
    store: Map<string, TrailSample[]>,
    live: ReadonlySet<string>,
    now: number,
    lifetime: number,
  ): void {
    for (const [id, samples] of store) {
      while (samples.length > 0 && now - samples[0].time > lifetime) samples.shift();
      if (samples.length === 0 || (!live.has(id) && now - samples[samples.length - 1].time > lifetime)) {
        store.delete(id);
      }
    }
  }
}

function renderArenaBase(
  commands: DrawCommand[],
  frame: ArenaFrame,
  viewport: Viewport,
  size: CanvasSize,
): void {
  addRect(commands, 0, 0, size.width, size.height, PALETTE.background);

  const bevel = Math.max(4 * size.dpr, viewport.scale * 0.16);
  addRect(
    commands,
    viewport.x - bevel * 1.8,
    viewport.y - bevel * 1.2,
    viewport.width + bevel * 3.6,
    viewport.height + bevel * 2.8,
    alpha(PALETTE.edgeShadow, 0.58),
  );
  addRect(commands, viewport.x - bevel, viewport.y - bevel, viewport.width + bevel * 2, viewport.height + bevel * 2, PALETTE.abyss);
  addRect(commands, viewport.x, viewport.y, viewport.width, viewport.height, PALETTE.floor);

  const centerX = viewport.x + viewport.width * 0.5;
  const centerY = viewport.y + viewport.height * 0.5;
  addPolygon(
    commands,
    [viewport.x, viewport.y, viewport.x + viewport.width, viewport.y, centerX, centerY],
    alpha(PALETTE.floorFacet, 0.3),
  );
  addPolygon(
    commands,
    [viewport.x + viewport.width, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height, centerX, centerY],
    alpha(PALETTE.floorFacet, 0.15),
  );
  addPolygon(
    commands,
    [viewport.x, viewport.y + viewport.height, centerX, centerY, viewport.x + viewport.width, viewport.y + viewport.height],
    alpha(PALETTE.black, 0.12),
  );

  const hairline = Math.max(0.75 * size.dpr, 1);
  for (let x = 0; x <= Math.floor(viewport.arenaWidth); x += 1) {
    const major = x % 4 === 0;
    const screenX = worldX(viewport, x);
    addLine(
      commands,
      screenX,
      viewport.y,
      screenX,
      viewport.y + viewport.height,
      major ? hairline * 1.25 : hairline,
      major ? PALETTE.gridMajor : PALETTE.grid,
      "butt",
    );
  }
  for (let y = 0; y <= Math.floor(viewport.arenaHeight); y += 1) {
    const major = y % 4 === 0;
    const screenY = worldY(viewport, y);
    addLine(
      commands,
      viewport.x,
      screenY,
      viewport.x + viewport.width,
      screenY,
      major ? hairline * 1.25 : hairline,
      major ? PALETTE.gridMajor : PALETTE.grid,
      "butt",
    );
  }

  const diagonal = alpha(PALETTE.edgeLight, 0.09);
  const diagonalStep = viewport.scale * 4;
  for (let offset = -viewport.height; offset < viewport.width; offset += diagonalStep) {
    const startX = viewport.x + Math.max(0, offset);
    const startY = viewport.y + Math.max(0, -offset);
    const length = Math.min(viewport.width - Math.max(0, offset), viewport.height - Math.max(0, -offset));
    if (length > 0) {
      addLine(commands, startX, startY, startX + length, startY + length, hairline, diagonal, "butt");
    }
  }

  for (const obstacle of frame.arena.obstacles) {
    const x = worldX(viewport, obstacle.x);
    const y = worldY(viewport, obstacle.y);
    const radius = Math.max(0.18, finite(obstacle.radius ?? obstacle.r, 0.7)) * viewport.scale;
    const seed = hashString(obstacle.id ?? `${obstacle.x}:${obstacle.y}`);
    addEllipse(commands, x + radius * 0.12, y + radius * 0.25, radius * 1.14, radius * 0.78, PALETTE.pillarShadow);
    addCircle(commands, x, y, radius * 1.16, alpha(PALETTE.cyan, 0.045));
    addRing(commands, x, y, radius * 1.03, radius * 0.14, PALETTE.pillarOuter);
    addCircle(commands, x, y, radius * 0.91, PALETTE.pillarInner);

    const rotation = noise(seed, 0) * Math.PI;
    const facetPoints: number[] = [];
    for (let point = 0; point < 6; point += 1) {
      const angle = rotation + (point / 6) * Math.PI * 2;
      const facetRadius = radius * (point % 2 === 0 ? 0.69 : 0.79);
      facetPoints.push(x + Math.cos(angle) * facetRadius, y + Math.sin(angle) * facetRadius);
    }
    addPolygon(commands, facetPoints, PALETTE.pillarFacet);
    addCircle(commands, x - radius * 0.18, y - radius * 0.2, radius * 0.21, alpha(PALETTE.white, 0.1));
    addRing(commands, x, y, radius * 0.53, Math.max(hairline, radius * 0.035), alpha(PALETTE.edgeLight, 0.45));
  }
}

function renderTrailPoints(
  commands: DrawCommand[],
  viewport: Viewport,
  points: readonly ArenaTrailPoint[],
  color: Color,
  baseRadius: number,
): void {
  points.forEach((point, index) => {
    const defaultLife = points.length > 1 ? 1 - index / (points.length - 1) : 0.35;
    const life = clamp(finite(point.life, defaultLife));
    const opacity = clamp(finite(point.alpha, 1)) * (1 - life);
    const radius = Math.max(0.03, finite(point.radius, baseRadius) * (1 - life * 0.34));
    addCircle(
      commands,
      worldX(viewport, point.x),
      worldY(viewport, point.y),
      radius * viewport.scale * 1.55,
      alpha(color, opacity * 0.08),
    );
    addCircle(
      commands,
      worldX(viewport, point.x),
      worldY(viewport, point.y),
      radius * viewport.scale,
      alpha(color, opacity * 0.22),
    );
  });
}

function renderAutomaticTrail(
  commands: DrawCommand[],
  viewport: Viewport,
  samples: readonly TrailSample[],
  now: number,
  lifetime: number,
  color: Color,
  radius: number,
): void {
  for (const sample of samples) {
    const life = clamp((now - sample.time) / lifetime);
    const strength = (1 - life) ** 1.6;
    addCircle(
      commands,
      worldX(viewport, sample.x),
      worldY(viewport, sample.y),
      viewport.scale * radius * (0.55 + strength * 0.45),
      alpha(color, strength * 0.18),
    );
  }
}

function renderPlayer(
  commands: DrawCommand[],
  player: ArenaPlayer,
  viewport: Viewport,
  frame: ArenaFrame,
  trails: MotionTrails,
): void {
  const now = finite(frame.now, performance.now());
  const color = playerColor(player);
  const x = worldX(viewport, player.x);
  const y = worldY(viewport, player.y);
  const radiusWorld = Math.max(0.18, finite(player.radius, 0.34));
  const radius = radiusWorld * viewport.scale;
  const alive = player.alive !== false;
  const local = frame.localId === player.id;
  const pulse = 0.5 + Math.sin(now * 0.006 + (hashString(player.id) % 31)) * 0.5;

  if (player.dashTrail?.length) {
    renderTrailPoints(commands, viewport, player.dashTrail, color, radiusWorld);
  }
  renderAutomaticTrail(commands, viewport, trails.playerTrail(player.id), now, 280, color, radiusWorld * 0.9);

  if (player.respawning === true || typeof player.respawnProgress === "number") {
    const respawnProgress = clamp(finite(player.respawnProgress, (now * 0.00045) % 1));
    for (let ring = 0; ring < 3; ring += 1) {
      const phase = (respawnProgress + ring * 0.24) % 1;
      addRing(
        commands,
        x,
        y,
        radius * (1.15 + phase * 1.35),
        Math.max(1, radius * 0.065),
        alpha(color, (1 - phase) * 0.48),
      );
    }
  }

  if (!alive) {
    addCircle(commands, x, y, radius * 1.5, alpha(color, 0.045));
    addRing(commands, x, y, radius * 0.88, radius * 0.1, alpha(color, 0.28));
    addLine(commands, x - radius * 0.48, y - radius * 0.48, x + radius * 0.48, y + radius * 0.48, radius * 0.13, alpha(color, 0.52));
    addLine(commands, x + radius * 0.48, y - radius * 0.48, x - radius * 0.48, y + radius * 0.48, radius * 0.13, alpha(color, 0.52));
    return;
  }

  let aimX = finite(player.aimX);
  let aimY = finite(player.aimY);
  const aimLength = Math.hypot(aimX, aimY);
  if (aimLength > 0.001) {
    aimX /= aimLength;
    aimY /= aimLength;
  } else {
    const velocityLength = Math.hypot(finite(player.vx), finite(player.vy));
    aimX = velocityLength > 0.01 ? finite(player.vx) / velocityLength : 1;
    aimY = velocityLength > 0.01 ? finite(player.vy) / velocityLength : 0;
  }

  const dashing =
    player.isDashing === true || finite(player.dashUntil, Number.NEGATIVE_INFINITY) > now;
  if (dashing) {
    const tailLength = radius * 2.6;
    addLine(commands, x - aimX * tailLength, y - aimY * tailLength, x, y, radius * 1.25, alpha(color, 0.08));
    addLine(commands, x - aimX * tailLength, y - aimY * tailLength, x, y, radius * 0.34, alpha(color, 0.42));
  }

  addEllipse(commands, x + radius * 0.12, y + radius * 0.48, radius * 0.9, radius * 0.53, alpha(PALETTE.black, 0.63));
  addCircle(commands, x, y, radius * (1.7 + pulse * 0.12), alpha(color, local ? 0.075 : 0.045));
  addCircle(commands, x, y, radius * 1.28, alpha(color, local ? 0.14 : 0.08));
  if (local) {
    addRing(commands, x, y, radius * 1.62, Math.max(1.5, radius * 0.075), alpha(PALETTE.white, 0.42 + pulse * 0.18));
    addRing(commands, x, y, radius * 1.43, Math.max(1, radius * 0.035), alpha(color, 0.72));
  }

  const aimStart = radius * 0.72;
  const aimEnd = radius * 2.2;
  addLine(
    commands,
    x + aimX * aimStart,
    y + aimY * aimStart,
    x + aimX * aimEnd,
    y + aimY * aimEnd,
    Math.max(2, radius * 0.18),
    alpha(PALETTE.black, 0.8),
  );
  addLine(
    commands,
    x + aimX * aimStart,
    y + aimY * aimStart,
    x + aimX * aimEnd,
    y + aimY * aimEnd,
    Math.max(1, radius * 0.075),
    alpha(color, 0.86),
  );

  addCircle(commands, x, y, radius * 1.02, PALETTE.black);
  addRing(commands, x, y, radius * 0.98, Math.max(2, radius * 0.14), alpha(color, 0.9));
  addCircle(commands, x, y, radius * 0.78, mix(PALETTE.floor, color, 0.28));

  const perpendicularX = -aimY;
  const perpendicularY = aimX;
  addPolygon(
    commands,
    [
      x + aimX * radius * 0.88,
      y + aimY * radius * 0.88,
      x - aimX * radius * 0.46 + perpendicularX * radius * 0.55,
      y - aimY * radius * 0.46 + perpendicularY * radius * 0.55,
      x - aimX * radius * 0.3,
      y - aimY * radius * 0.3,
      x - aimX * radius * 0.46 - perpendicularX * radius * 0.55,
      y - aimY * radius * 0.46 - perpendicularY * radius * 0.55,
    ],
    alpha(color, 0.92),
  );
  addCircle(commands, x + aimX * radius * 0.2, y + aimY * radius * 0.2, radius * 0.2, PALETTE.white);

  if (finite(player.soakedUntil, Number.NEGATIVE_INFINITY) > now) {
    addRing(commands, x, y, radius * 1.25, Math.max(1, radius * 0.06), alpha(PALETTE.tide, 0.74));
  }
  if (finite(player.stunnedUntil, Number.NEGATIVE_INFINITY) > now) {
    const boltY = y - radius * 1.45;
    addLine(commands, x - radius * 0.62, boltY, x - radius * 0.12, boltY - radius * 0.28, radius * 0.1, PALETTE.volt);
    addLine(commands, x - radius * 0.12, boltY - radius * 0.28, x + radius * 0.3, boltY + radius * 0.12, radius * 0.1, PALETTE.volt);
  }

  const health = finite(player.health, Number.NaN);
  const maxHealth = finite(player.maxHealth, Number.NaN);
  if (Number.isFinite(health) && Number.isFinite(maxHealth) && maxHealth > 0) {
    const ratio = clamp(health / maxHealth);
    const barWidth = radius * 2.25;
    const barY = y - radius * 1.55;
    addLine(commands, x - barWidth * 0.5, barY, x + barWidth * 0.5, barY, Math.max(3, radius * 0.19), alpha(PALETTE.black, 0.9), "butt");
    if (ratio > 0.001) {
      const barColor = ratio < 0.3 ? PALETTE.danger : mix(PALETTE.gold, PALETTE.health, clamp((ratio - 0.3) / 0.7));
      addLine(
        commands,
        x - barWidth * 0.5,
        barY,
        x - barWidth * 0.5 + barWidth * ratio,
        barY,
        Math.max(1.5, radius * 0.1),
        barColor,
        "butt",
      );
    }
  }
}

function renderProjectile(
  commands: DrawCommand[],
  projectile: ArenaProjectile,
  viewport: Viewport,
  frame: ArenaFrame,
  trails: MotionTrails,
): void {
  const kind = projectileKind(projectile);
  const color = parseColor(projectile.color, spellColor(kind));
  const x = worldX(viewport, projectile.x);
  const y = worldY(viewport, projectile.y);
  const radiusWorld = Math.max(0.07, finite(projectile.radius, 0.15));
  const radius = radiusWorld * viewport.scale;
  const now = finite(frame.now, performance.now());

  renderAutomaticTrail(commands, viewport, trails.projectileTrail(projectile.id), now, 180, color, radiusWorld * 0.78);
  if (projectile.trail?.length) {
    renderTrailPoints(commands, viewport, projectile.trail, color, radiusWorld * 0.75);
  }

  const previousX = projectile.prevX;
  const previousY = projectile.prevY;
  if (typeof previousX === "number" && typeof previousY === "number") {
    addLine(
      commands,
      worldX(viewport, previousX),
      worldY(viewport, previousY),
      x,
      y,
      radius * 1.5,
      alpha(color, 0.09),
    );
    addLine(
      commands,
      worldX(viewport, previousX),
      worldY(viewport, previousY),
      x,
      y,
      radius * 0.5,
      alpha(color, 0.42),
    );
  }

  let directionX = finite(projectile.vx, 1);
  let directionY = finite(projectile.vy);
  const directionLength = Math.hypot(directionX, directionY);
  directionX = directionLength > 0.001 ? directionX / directionLength : 1;
  directionY = directionLength > 0.001 ? directionY / directionLength : 0;
  const perpendicularX = -directionY;
  const perpendicularY = directionX;

  addCircle(commands, x, y, radius * 2.8, alpha(color, 0.055));
  addCircle(commands, x, y, radius * 1.7, alpha(color, 0.13));

  if (kind === "tide" || kind === "tide-burst") {
    addRing(commands, x, y, radius * 1.22, Math.max(1, radius * 0.2), alpha(color, 0.84));
    addCircle(commands, x, y, radius * 0.74, mix(color, PALETTE.white, 0.5));
    addCircle(commands, x - radius * 0.18, y - radius * 0.2, radius * 0.22, PALETTE.white);
  } else if (kind === "volt" || kind === "volt-lance") {
    addPolygon(
      commands,
      [
        x + directionX * radius * 1.55,
        y + directionY * radius * 1.55,
        x + perpendicularX * radius * 0.72,
        y + perpendicularY * radius * 0.72,
        x - directionX * radius * 1.12,
        y - directionY * radius * 1.12,
        x - perpendicularX * radius * 0.72,
        y - perpendicularY * radius * 0.72,
      ],
      color,
    );
    addLine(commands, x - directionX * radius, y - directionY * radius, x + directionX * radius, y + directionY * radius, radius * 0.24, PALETTE.white);
  } else if (kind === "arcane") {
    const points: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2 + now * 0.004;
      const pointRadius = index % 2 === 0 ? radius * 1.35 : radius * 0.62;
      points.push(x + Math.cos(angle) * pointRadius, y + Math.sin(angle) * pointRadius);
    }
    addPolygon(commands, points, color);
    addCircle(commands, x, y, radius * 0.46, PALETTE.white);
  } else {
    addPolygon(
      commands,
      [
        x + directionX * radius * 1.5,
        y + directionY * radius * 1.5,
        x + perpendicularX * radius * 0.74,
        y + perpendicularY * radius * 0.74,
        x - directionX * radius * 1.18,
        y - directionY * radius * 1.18,
        x - perpendicularX * radius * 0.74,
        y - perpendicularY * radius * 0.74,
      ],
      color,
    );
    addCircle(commands, x + directionX * radius * 0.25, y + directionY * radius * 0.25, radius * 0.42, PALETTE.white);
  }
}

function renderTideRing(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  progress: number,
): void {
  const color = parseColor(effect.color, PALETTE.tide);
  const x = worldX(viewport, effect.x);
  const y = worldY(viewport, effect.y);
  const maxRadius = Math.max(0.2, finite("maxRadius" in effect ? effect.maxRadius : undefined, finite(effect.radius, 2.15)));
  const radius = maxRadius * (0.15 + progress * 0.85) * viewport.scale;
  const opacity = (1 - progress) ** 0.65;
  const width = Math.max(1, finite("width" in effect ? effect.width : undefined, 0.11) * viewport.scale);
  addCircle(commands, x, y, radius * 1.12, alpha(color, opacity * 0.025));
  addRing(commands, x, y, radius, width * 3.5, alpha(color, opacity * 0.12));
  addRing(commands, x, y, radius, width, alpha(mix(color, PALETTE.white, 0.42), opacity * 0.9));
  addRing(commands, x, y, radius * 0.72, width * 0.55, alpha(color, opacity * 0.32));
}

function renderVoltLance(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  progress: number,
  index: number,
): void {
  const color = parseColor(effect.color, PALETTE.volt);
  const startX = worldX(viewport, effect.x);
  const startY = worldY(viewport, effect.y);
  let endWorldX: number;
  let endWorldY: number;
  if ("x2" in effect && typeof effect.x2 === "number" && typeof effect.y2 === "number") {
    endWorldX = effect.x2;
    endWorldY = effect.y2;
  } else {
    const angle = finite("angle" in effect ? effect.angle : undefined);
    const length = Math.max(0.2, finite("length" in effect ? effect.length : undefined, 4.2));
    endWorldX = effect.x + Math.cos(angle) * length;
    endWorldY = effect.y + Math.sin(angle) * length;
  }
  const endX = worldX(viewport, endWorldX);
  const endY = worldY(viewport, endWorldY);
  const width = Math.max(1, finite("width" in effect ? effect.width : undefined, 0.12) * viewport.scale);
  const opacity = (1 - progress) ** 0.52;
  addLine(commands, startX, startY, endX, endY, width * 7.5, alpha(color, opacity * 0.055));
  addLine(commands, startX, startY, endX, endY, width * 3.2, alpha(color, opacity * 0.2));
  addLine(commands, startX, startY, endX, endY, width, alpha(PALETTE.white, opacity * 0.92));

  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const perpendicularX = -dy / length;
  const perpendicularY = dx / length;
  const seed = hashString(effect.id ?? `volt:${index}`);
  for (let branch = 0; branch < 5; branch += 1) {
    const along = 0.16 + noise(seed, branch) * 0.7;
    const branchLength = viewport.scale * (0.18 + noise(seed, branch + 9) * 0.34);
    const sign = noise(seed, branch + 19) > 0.5 ? 1 : -1;
    const branchStartX = startX + dx * along;
    const branchStartY = startY + dy * along;
    addLine(
      commands,
      branchStartX,
      branchStartY,
      branchStartX + perpendicularX * branchLength * sign + (dx / length) * branchLength * 0.3,
      branchStartY + perpendicularY * branchLength * sign + (dy / length) * branchLength * 0.3,
      Math.max(1, width * 0.42),
      alpha(color, opacity * 0.66),
    );
  }
  addCircle(commands, endX, endY, width * 4.2, alpha(color, opacity * 0.12));
  addCircle(commands, endX, endY, width * 1.25, alpha(PALETTE.white, opacity * 0.9));
}

function renderDashEffect(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  progress: number,
): void {
  const color = parseColor(effect.color, PALETTE.cyan);
  const x1 = worldX(viewport, effect.x);
  const y1 = worldY(viewport, effect.y);
  const x2 = worldX(viewport, "x2" in effect ? finite(effect.x2, effect.x) : effect.x);
  const y2 = worldY(viewport, "y2" in effect ? finite(effect.y2, effect.y) : effect.y);
  const opacity = (1 - progress) ** 1.35;
  const width = viewport.scale * Math.max(0.2, finite(effect.radius, 0.34));
  addLine(commands, x1, y1, x2, y2, width * 2.1, alpha(color, opacity * 0.06));
  addLine(commands, x1, y1, x2, y2, width * 0.52, alpha(color, opacity * 0.34));
  for (let ghost = 0; ghost < 4; ghost += 1) {
    const amount = (ghost + 0.5) / 4;
    addCircle(
      commands,
      x1 + (x2 - x1) * amount,
      y1 + (y2 - y1) * amount,
      width * (0.72 - ghost * 0.07),
      alpha(color, opacity * (0.1 + ghost * 0.025)),
    );
  }
  if ("points" in effect && effect.points?.length) {
    renderTrailPoints(commands, viewport, effect.points, color, Math.max(0.18, finite(effect.radius, 0.34)));
  }
}

function renderHitEffect(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  progress: number,
  index: number,
): void {
  const kind = effectKind(effect);
  const fallback = kind === "death" ? PALETTE.magenta : kind === "cinder-impact" ? PALETTE.ember : PALETTE.gold;
  const color = parseColor(effect.color, fallback);
  const x = worldX(viewport, effect.x);
  const y = worldY(viewport, effect.y);
  const radius = Math.max(0.18, finite(effect.radius, kind === "death" ? 1.2 : 0.62)) * viewport.scale;
  const expandedRadius = radius * (0.25 + progress * 0.9);
  const opacity = (1 - progress) ** 0.9;
  addCircle(commands, x, y, expandedRadius * 1.5, alpha(color, opacity * 0.045));
  addRing(commands, x, y, expandedRadius, Math.max(1, radius * 0.08), alpha(color, opacity * 0.7));
  const seed = hashString(effect.id ?? `hit:${index}`);
  for (let ray = 0; ray < (kind === "death" ? 12 : 8); ray += 1) {
    const angle = (ray / (kind === "death" ? 12 : 8)) * Math.PI * 2 + noise(seed, ray) * 0.3;
    const start = expandedRadius * (0.52 + noise(seed, ray + 13) * 0.16);
    const end = expandedRadius * (0.95 + noise(seed, ray + 29) * 0.6);
    addLine(
      commands,
      x + Math.cos(angle) * start,
      y + Math.sin(angle) * start,
      x + Math.cos(angle) * end,
      y + Math.sin(angle) * end,
      Math.max(1, radius * 0.055),
      alpha(ray % 3 === 0 ? PALETTE.white : color, opacity * 0.8),
    );
  }
  addCircle(commands, x, y, Math.max(1, radius * 0.16 * (1 - progress)), alpha(PALETTE.white, opacity));
}

function renderRespawnEffect(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  progress: number,
): void {
  const color = parseColor(effect.color, PALETTE.blue);
  const x = worldX(viewport, effect.x);
  const y = worldY(viewport, effect.y);
  const baseRadius = Math.max(0.3, finite(effect.radius, 0.95)) * viewport.scale;
  const opacity = Math.sin(clamp(progress) * Math.PI) * 0.8 + 0.18;
  for (let ring = 0; ring < 3; ring += 1) {
    const phase = (progress + ring * 0.22) % 1;
    const radius = baseRadius * (0.34 + phase * 0.95);
    addRing(commands, x, y, radius, Math.max(1, baseRadius * 0.045), alpha(color, opacity * (1 - phase) * 0.72));
  }
  const diamondRadius = baseRadius * (0.75 + Math.sin(progress * Math.PI * 4) * 0.08);
  addPolygon(
    commands,
    [x, y - diamondRadius, x + diamondRadius * 0.58, y, x, y + diamondRadius, x - diamondRadius * 0.58, y],
    alpha(color, opacity * 0.13),
  );
  addLine(commands, x, y - diamondRadius * 1.2, x, y + diamondRadius * 1.2, Math.max(1, baseRadius * 0.035), alpha(PALETTE.white, opacity * 0.5));
  addCircle(commands, x, y, baseRadius * 0.13, alpha(PALETTE.white, opacity * 0.85));
}

function renderEffect(
  commands: DrawCommand[],
  effect: ArenaEffect,
  viewport: Viewport,
  frame: ArenaFrame,
  index: number,
): void {
  const progress = effectProgress(effect, finite(frame.now, performance.now()));
  switch (effectKind(effect)) {
    case "tide-ring":
      renderTideRing(commands, effect, viewport, progress);
      break;
    case "volt-lance":
      renderVoltLance(commands, effect, viewport, progress, index);
      break;
    case "dash":
      renderDashEffect(commands, effect, viewport, progress);
      break;
    case "respawn":
    case "spawn":
      renderRespawnEffect(commands, effect, viewport, progress);
      break;
    case "death":
    case "cinder-impact":
    case "hit":
    default:
      renderHitEffect(commands, effect, viewport, progress, index);
      break;
  }
}

function renderArenaBoundary(commands: DrawCommand[], viewport: Viewport, size: CanvasSize): void {
  const outerWidth = Math.max(2 * size.dpr, viewport.scale * 0.095);
  const innerWidth = Math.max(1 * size.dpr, viewport.scale * 0.025);
  const x1 = viewport.x;
  const y1 = viewport.y;
  const x2 = viewport.x + viewport.width;
  const y2 = viewport.y + viewport.height;
  addLine(commands, x1, y1, x2, y1, outerWidth, PALETTE.edge, "butt");
  addLine(commands, x2, y1, x2, y2, outerWidth, PALETTE.edge, "butt");
  addLine(commands, x2, y2, x1, y2, outerWidth, PALETTE.edge, "butt");
  addLine(commands, x1, y2, x1, y1, outerWidth, PALETTE.edge, "butt");
  addLine(commands, x1, y1, x2, y1, innerWidth, PALETTE.edgeLight, "butt");
  addLine(commands, x1, y1, x1, y2, innerWidth, PALETTE.edgeLight, "butt");

  const corner = Math.min(viewport.scale * 0.8, viewport.width * 0.06);
  const cornerColor = alpha(PALETTE.cyan, 0.55);
  addLine(commands, x1, y1, x1 + corner, y1, innerWidth * 1.6, cornerColor, "butt");
  addLine(commands, x1, y1, x1, y1 + corner, innerWidth * 1.6, cornerColor, "butt");
  addLine(commands, x2, y2, x2 - corner, y2, innerWidth * 1.6, alpha(PALETTE.magenta, 0.48), "butt");
  addLine(commands, x2, y2, x2, y2 - corner, innerWidth * 1.6, alpha(PALETTE.magenta, 0.48), "butt");
}

function buildScene(frame: ArenaFrame, size: CanvasSize, trails: MotionTrails): DrawCommand[] {
  trails.update(frame);
  const viewport = makeViewport(frame, size);
  const commands: DrawCommand[] = [];
  renderArenaBase(commands, frame, viewport, size);

  frame.effects.forEach((effect, index) => renderEffect(commands, effect, viewport, frame, index));
  frame.projectiles.forEach((projectile) => renderProjectile(commands, projectile, viewport, frame, trails));
  frame.players.forEach((player) => renderPlayer(commands, player, viewport, frame, trails));
  renderArenaBoundary(commands, viewport, size);
  return commands;
}

class Canvas2DArenaRenderer implements ArenaRenderer {
  readonly mode = "canvas2d" as const;
  private size?: CanvasSize;
  private readonly trails = new MotionTrails();
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
  ) {
    this.context.imageSmoothingEnabled = true;
    this.resize();
  }

  resize(): void {
    if (this.destroyed) return;
    this.size = syncCanvasSize(this.canvas, this.size);
  }

  render(frame: ArenaFrame): void {
    if (this.destroyed) return;
    this.resize();
    const size = this.size;
    if (!size) return;
    const commands = buildScene(frame, size, this.trails);
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, size.width, size.height);

    for (const command of commands) {
      context.fillStyle = colorToCss(command.color);
      context.strokeStyle = colorToCss(command.color);
      switch (command.kind) {
        case "rect":
          context.fillRect(command.x, command.y, command.width, command.height);
          break;
        case "circle":
          context.beginPath();
          context.arc(command.x, command.y, command.radius, 0, Math.PI * 2);
          context.fill();
          break;
        case "ellipse":
          context.beginPath();
          context.ellipse(command.x, command.y, command.radiusX, command.radiusY, 0, 0, Math.PI * 2);
          context.fill();
          break;
        case "line":
          context.beginPath();
          context.lineCap = command.cap;
          context.lineWidth = command.width;
          context.moveTo(command.x1, command.y1);
          context.lineTo(command.x2, command.y2);
          context.stroke();
          break;
        case "ring":
          context.beginPath();
          context.lineCap = "round";
          context.lineWidth = command.width;
          context.arc(command.x, command.y, command.radius, 0, Math.PI * 2);
          context.stroke();
          break;
        case "polygon":
          context.beginPath();
          context.moveTo(command.points[0], command.points[1]);
          for (let index = 2; index < command.points.length; index += 2) {
            context.lineTo(command.points[index], command.points[index + 1]);
          }
          context.closePath();
          context.fill();
          break;
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.trails.clear();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

interface GPUBufferLike {
  destroy(): void;
}

type GPURenderPipelineLike = object;

interface GPURenderPassLike {
  setPipeline(pipeline: GPURenderPipelineLike): void;
  setVertexBuffer(slot: number, buffer: GPUBufferLike): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GPUCommandEncoderLike {
  beginRenderPass(descriptor: unknown): GPURenderPassLike;
  finish(): unknown;
}

interface GPUQueueLike {
  writeBuffer(buffer: GPUBufferLike, bufferOffset: number, data: ArrayBufferView): void;
  submit(commandBuffers: readonly unknown[]): void;
}

interface GPUDeviceLike {
  readonly queue: GPUQueueLike;
  readonly lost?: Promise<unknown>;
  createShaderModule(descriptor: unknown): unknown;
  createRenderPipeline(descriptor: unknown): GPURenderPipelineLike;
  createBuffer(descriptor: unknown): GPUBufferLike;
  createCommandEncoder(descriptor?: unknown): GPUCommandEncoderLike;
  destroy?(): void;
}

interface GPUAdapterLike {
  requestDevice(descriptor?: unknown): Promise<GPUDeviceLike>;
}

interface GPUEntryLike {
  requestAdapter(options?: unknown): Promise<GPUAdapterLike | null>;
  getPreferredCanvasFormat?(): string;
}

interface GPUTextureLike {
  createView(descriptor?: unknown): unknown;
}

interface GPUCanvasContextLike {
  configure(descriptor: unknown): void;
  getCurrentTexture(): GPUTextureLike;
  unconfigure?(): void;
}

function pushVertex(
  vertices: number[],
  size: CanvasSize,
  x: number,
  y: number,
  color: Color,
): void {
  vertices.push(
    (x / size.width) * 2 - 1,
    1 - (y / size.height) * 2,
    color[0],
    color[1],
    color[2],
    color[3],
  );
}

function pushTriangle(
  vertices: number[],
  size: CanvasSize,
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
  thirdX: number,
  thirdY: number,
  color: Color,
): void {
  pushVertex(vertices, size, firstX, firstY, color);
  pushVertex(vertices, size, secondX, secondY, color);
  pushVertex(vertices, size, thirdX, thirdY, color);
}

function appendCircleVertices(
  vertices: number[],
  size: CanvasSize,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  color: Color,
): void {
  const segments = Math.max(14, Math.min(48, Math.ceil(Math.max(radiusX, radiusY) * 0.34)));
  for (let segment = 0; segment < segments; segment += 1) {
    const firstAngle = (segment / segments) * Math.PI * 2;
    const secondAngle = ((segment + 1) / segments) * Math.PI * 2;
    pushTriangle(
      vertices,
      size,
      x,
      y,
      x + Math.cos(firstAngle) * radiusX,
      y + Math.sin(firstAngle) * radiusY,
      x + Math.cos(secondAngle) * radiusX,
      y + Math.sin(secondAngle) * radiusY,
      color,
    );
  }
}

function appendLineVertices(
  vertices: number[],
  size: CanvasSize,
  command: LineCommand,
): void {
  const dx = command.x2 - command.x1;
  const dy = command.y2 - command.y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  const normalX = (-dy / length) * command.width * 0.5;
  const normalY = (dx / length) * command.width * 0.5;
  pushTriangle(
    vertices,
    size,
    command.x1 + normalX,
    command.y1 + normalY,
    command.x1 - normalX,
    command.y1 - normalY,
    command.x2 - normalX,
    command.y2 - normalY,
    command.color,
  );
  pushTriangle(
    vertices,
    size,
    command.x1 + normalX,
    command.y1 + normalY,
    command.x2 - normalX,
    command.y2 - normalY,
    command.x2 + normalX,
    command.y2 + normalY,
    command.color,
  );
  if (command.cap === "round") {
    appendCircleVertices(vertices, size, command.x1, command.y1, command.width * 0.5, command.width * 0.5, command.color);
    appendCircleVertices(vertices, size, command.x2, command.y2, command.width * 0.5, command.width * 0.5, command.color);
  }
}

function appendRingVertices(
  vertices: number[],
  size: CanvasSize,
  command: RingCommand,
): void {
  const outerRadius = command.radius + command.width * 0.5;
  const innerRadius = Math.max(0, command.radius - command.width * 0.5);
  if (innerRadius <= 0.001) {
    appendCircleVertices(vertices, size, command.x, command.y, outerRadius, outerRadius, command.color);
    return;
  }
  const segments = Math.max(18, Math.min(56, Math.ceil(outerRadius * 0.36)));
  for (let segment = 0; segment < segments; segment += 1) {
    const firstAngle = (segment / segments) * Math.PI * 2;
    const secondAngle = ((segment + 1) / segments) * Math.PI * 2;
    const outerFirstX = command.x + Math.cos(firstAngle) * outerRadius;
    const outerFirstY = command.y + Math.sin(firstAngle) * outerRadius;
    const outerSecondX = command.x + Math.cos(secondAngle) * outerRadius;
    const outerSecondY = command.y + Math.sin(secondAngle) * outerRadius;
    const innerFirstX = command.x + Math.cos(firstAngle) * innerRadius;
    const innerFirstY = command.y + Math.sin(firstAngle) * innerRadius;
    const innerSecondX = command.x + Math.cos(secondAngle) * innerRadius;
    const innerSecondY = command.y + Math.sin(secondAngle) * innerRadius;
    pushTriangle(
      vertices,
      size,
      outerFirstX,
      outerFirstY,
      innerFirstX,
      innerFirstY,
      innerSecondX,
      innerSecondY,
      command.color,
    );
    pushTriangle(
      vertices,
      size,
      outerFirstX,
      outerFirstY,
      innerSecondX,
      innerSecondY,
      outerSecondX,
      outerSecondY,
      command.color,
    );
  }
}

function triangulate(commands: readonly DrawCommand[], size: CanvasSize): Float32Array {
  const vertices: number[] = [];
  for (const command of commands) {
    switch (command.kind) {
      case "rect": {
        const x2 = command.x + command.width;
        const y2 = command.y + command.height;
        pushTriangle(vertices, size, command.x, command.y, command.x, y2, x2, y2, command.color);
        pushTriangle(vertices, size, command.x, command.y, x2, y2, x2, command.y, command.color);
        break;
      }
      case "circle":
        appendCircleVertices(vertices, size, command.x, command.y, command.radius, command.radius, command.color);
        break;
      case "ellipse":
        appendCircleVertices(vertices, size, command.x, command.y, command.radiusX, command.radiusY, command.color);
        break;
      case "line":
        appendLineVertices(vertices, size, command);
        break;
      case "ring":
        appendRingVertices(vertices, size, command);
        break;
      case "polygon":
        for (let index = 2; index < command.points.length - 2; index += 2) {
          pushTriangle(
            vertices,
            size,
            command.points[0],
            command.points[1],
            command.points[index],
            command.points[index + 1],
            command.points[index + 2],
            command.points[index + 3],
            command.color,
          );
        }
        break;
    }
  }
  return new Float32Array(vertices);
}

interface WebGPUResources {
  readonly device: GPUDeviceLike;
  readonly pipeline: GPURenderPipelineLike;
  readonly format: string;
}

class WebGPUArenaRenderer implements ArenaRenderer {
  readonly mode = "webgpu" as const;
  private size?: CanvasSize;
  private vertexBuffer?: GPUBufferLike;
  private vertexBufferBytes = 0;
  private readonly trails = new MotionTrails();
  private destroyed = false;
  private deviceLost = false;
  private recovering = false;
  private recoveryAttempt = 0;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private latestFrame?: ArenaFrame;
  private device: GPUDeviceLike;
  private pipeline: GPURenderPipelineLike;
  private format: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: GPUCanvasContextLike,
    resources: WebGPUResources,
    private readonly recreateResources: () => Promise<WebGPUResources | null>,
  ) {
    this.device = resources.device;
    this.pipeline = resources.pipeline;
    this.format = resources.format;
    this.resize();
    this.watchDeviceLoss(this.device);
  }

  resize(): void {
    if (this.destroyed) return;
    const previous = this.size;
    this.size = syncCanvasSize(this.canvas, previous);
    if (this.deviceLost) return;
    if (!previous || previous.width !== this.size.width || previous.height !== this.size.height) {
      try {
        this.context.configure({
          device: this.device,
          format: this.format,
          alphaMode: "opaque",
        });
      } catch {
        this.beginRecovery();
      }
    }
  }

  render(frame: ArenaFrame): void {
    if (this.destroyed) return;
    this.latestFrame = frame;
    if (this.deviceLost) {
      if (!this.recovering && !this.recoveryTimer) this.beginRecovery();
      return;
    }
    this.resize();
    if (this.deviceLost) return;
    const size = this.size;
    if (!size) return;
    const commands = buildScene(frame, size, this.trails);
    const vertices = triangulate(commands, size);
    if (vertices.length === 0) return;
    try {
      this.ensureVertexBuffer(vertices.byteLength);
      if (!this.vertexBuffer) return;
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

      const encoder = this.device.createCommandEncoder({ label: "Arcane Arena frame encoder" });
      const pass = encoder.beginRenderPass({
        label: "Arcane Arena render pass",
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: {
              r: PALETTE.background[0],
              g: PALETTE.background[1],
              b: PALETTE.background[2],
              a: 1,
            },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.draw(vertices.length / FLOATS_PER_VERTEX);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch {
      this.beginRecovery();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.latestFrame = undefined;
    this.trails.clear();
    try {
      this.vertexBuffer?.destroy();
    } catch {
      // A buffer belonging to a lost device may already be invalid.
    }
    this.vertexBuffer = undefined;
    this.context.unconfigure?.();
    this.device.destroy?.();
  }

  private ensureVertexBuffer(requiredBytes: number): void {
    if (this.vertexBuffer && this.vertexBufferBytes >= requiredBytes) return;
    this.vertexBuffer?.destroy();
    let capacity = 4096;
    while (capacity < requiredBytes) capacity *= 2;
    const usage = (
      globalThis as typeof globalThis & {
        GPUBufferUsage?: { VERTEX: number; COPY_DST: number };
      }
    ).GPUBufferUsage;
    this.vertexBuffer = this.device.createBuffer({
      label: "Arcane Arena dynamic vertices",
      size: capacity,
      usage: (usage?.VERTEX ?? 0x20) | (usage?.COPY_DST ?? 0x08),
    });
    this.vertexBufferBytes = capacity;
  }

  private watchDeviceLoss(device: GPUDeviceLike): void {
    void device.lost?.then(() => {
      if (this.destroyed || this.device !== device) return;
      this.beginRecovery();
    });
  }

  private beginRecovery(): void {
    if (this.destroyed || this.recovering) return;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    this.deviceLost = true;
    this.recovering = true;
    try {
      this.vertexBuffer?.destroy();
    } catch {
      // The loss notification can arrive after WebGPU invalidates its buffers.
    }
    this.vertexBuffer = undefined;
    this.vertexBufferBytes = 0;
    try {
      this.device.destroy?.();
    } catch {
      // The device may already be fully lost.
    }

    void this.recreateResources()
      .then((resources) => {
        if (this.destroyed) {
          resources?.device.destroy?.();
          return;
        }
        if (!resources) {
          this.scheduleRecovery();
          return;
        }

        try {
          this.size = syncCanvasSize(this.canvas, this.size);
          this.context.configure({
            device: resources.device,
            format: resources.format,
            alphaMode: "opaque",
          });
        } catch {
          resources.device.destroy?.();
          this.scheduleRecovery();
          return;
        }

        this.device = resources.device;
        this.pipeline = resources.pipeline;
        this.format = resources.format;
        this.deviceLost = false;
        this.recovering = false;
        this.recoveryAttempt = 0;
        this.watchDeviceLoss(resources.device);

        const frame = this.latestFrame;
        if (frame) this.render(frame);
      })
      .catch(() => {
        this.scheduleRecovery();
      });
  }

  private scheduleRecovery(): void {
    this.recovering = false;
    if (this.destroyed || this.recoveryTimer) return;
    const delay = Math.min(4_000, 250 * 2 ** Math.min(this.recoveryAttempt, 4));
    this.recoveryAttempt += 1;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.beginRecovery();
    }, delay);
  }
}

const SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vertexMain(
  @location(0) position: vec2f,
  @location(1) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color.rgb * input.color.a, input.color.a);
}
`;

async function createWebGPUResources(gpu: GPUEntryLike): Promise<WebGPUResources | null> {
  let device: GPUDeviceLike | undefined;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    device = await adapter.requestDevice();
    const format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    const shader = device.createShaderModule({ label: "Arcane Arena shader", code: SHADER });
    const pipeline = device.createRenderPipeline({
      label: "Arcane Arena 2D pipeline",
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fragmentMain",
        targets: [
          {
            format,
            blend: {
              color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
            writeMask: 0x0f,
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    return { device, pipeline, format };
  } catch {
    device?.destroy?.();
    return null;
  }
}

async function tryCreateWebGPURenderer(canvas: HTMLCanvasElement): Promise<ArenaRenderer | null> {
  const gpu = (navigator as Navigator & { gpu?: GPUEntryLike }).gpu;
  if (!gpu) return null;

  try {
    const resources = await createWebGPUResources(gpu);
    if (!resources) return null;

    const getContext = canvas.getContext.bind(canvas) as (contextId: string) => RenderingContext | null;
    const context = getContext("webgpu") as unknown as GPUCanvasContextLike | null;
    if (!context) {
      resources.device.destroy?.();
      return null;
    }
    return new WebGPUArenaRenderer(canvas, context, resources, () => createWebGPUResources(gpu));
  } catch {
    return null;
  }
}

/**
 * Creates a responsive arena renderer. WebGPU is preferred; unsupported or
 * blocked devices transparently use Canvas2D. The asynchronous boundary is
 * required by WebGPU adapter/device discovery.
 */
export async function createArenaRenderer(canvas: HTMLCanvasElement): Promise<ArenaRenderer> {
  const webgpu = await tryCreateWebGPURenderer(canvas);
  if (webgpu) return webgpu;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Arcane Arena could not create a WebGPU or Canvas2D rendering context.");
  }
  return new Canvas2DArenaRenderer(canvas, context);
}

export type {
  ArenaDefinition,
  ArenaEffect,
  ArenaFrame,
  ArenaPlayer,
  ArenaProjectile,
  ArenaRenderer,
} from "./types";
