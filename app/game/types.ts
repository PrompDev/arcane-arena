/** Coordinates are expressed in arena units (24 x 14 by default). */
export interface ArenaPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Colours may be one of the renderer palette names or a CSS-style hex/rgb
 * value. Unsupported strings safely fall back to the entity's palette colour.
 */
export type ArenaColor =
  | "cyan"
  | "magenta"
  | "gold"
  | "blue"
  | "ember"
  | "tide"
  | "volt"
  | "arcane"
  | (string & {});

export type ArenaObstacle = ArenaPoint &
  (
    | {
        readonly radius: number;
        readonly r?: number;
      }
    | {
        readonly r: number;
        readonly radius?: number;
      }
  ) & {
    readonly id?: string;
  };

export interface ArenaDefinition {
  /** Arena width in simulation units. The canonical arena is 24. */
  readonly width: number;
  /** Arena height in simulation units. The canonical arena is 14. */
  readonly height: number;
  readonly obstacles: readonly ArenaObstacle[];
}

export interface ArenaTrailPoint extends ArenaPoint {
  /** 0 is fresh and 1 is fully faded. */
  readonly life?: number;
  /** Optional explicit opacity multiplier. */
  readonly alpha?: number;
  readonly radius?: number;
}

export interface ArenaCooldowns {
  readonly dash?: number;
  readonly primary?: number;
  readonly secondary?: number;
  readonly utility?: number;
}

export interface ArenaPlayer extends ArenaPoint {
  readonly id: string;
  readonly name?: string;
  readonly vx?: number;
  readonly vy?: number;
  /** Normalized aim vector. A zero vector is accepted. */
  readonly aimX: number;
  readonly aimY: number;
  readonly radius?: number;
  readonly color?: ArenaColor;
  readonly health?: number;
  readonly maxHealth?: number;
  readonly kills?: number;
  readonly deaths?: number;
  readonly alive?: boolean;
  readonly respawning?: boolean;
  readonly respawnAt?: number;
  readonly respawnProgress?: number;
  readonly soakedUntil?: number;
  readonly stunnedUntil?: number;
  readonly dashUntil?: number;
  readonly isDashing?: boolean;
  readonly cooldowns?: ArenaCooldowns;
  readonly dashTrail?: readonly ArenaTrailPoint[];
}

export type ArenaSpellKind =
  | "cinder-shot"
  | "ember"
  | "tide"
  | "tide-burst"
  | "volt"
  | "volt-lance"
  | "arcane";

interface ArenaProjectileBase extends ArenaPoint {
  readonly id: string;
  readonly ownerId?: string;
  readonly vx?: number;
  readonly vy?: number;
  readonly radius?: number;
  readonly color?: ArenaColor;
  readonly prevX?: number;
  readonly prevY?: number;
  readonly expiresAt?: number;
  readonly trail?: readonly ArenaTrailPoint[];
}

/** Accepts either the renderer's `kind` name or the server's `spell` name. */
export type ArenaProjectile = ArenaProjectileBase &
  (
    | {
        readonly kind: ArenaSpellKind;
        readonly spell?: ArenaSpellKind;
      }
    | {
        readonly spell: ArenaSpellKind;
        readonly kind?: ArenaSpellKind;
      }
  );

interface ArenaEffectBase extends ArenaPoint {
  readonly id?: string;
  readonly ownerId?: string;
  readonly color?: ArenaColor;
  /** 0 is newly created and 1 is complete. */
  readonly progress?: number;
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly duration?: number;
  readonly radius?: number;
}

export type ArenaEffectKind =
  | "tide-ring"
  | "volt-lance"
  | "dash"
  | "hit"
  | "cinder-impact"
  | "death"
  | "respawn"
  | "spawn";

interface ArenaEffectGeometry {
  readonly maxRadius?: number;
  readonly width?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly angle?: number;
  readonly length?: number;
  readonly points?: readonly ArenaTrailPoint[];
  readonly normalX?: number;
  readonly normalY?: number;
}

/**
 * Effect-specific geometry is optional. The renderer supplies readable visual
 * defaults, so a server effect containing only id/type/x/y/timestamps is valid.
 */
export type ArenaEffect = ArenaEffectBase &
  ArenaEffectGeometry &
  (
    | {
        readonly kind: ArenaEffectKind;
        readonly type?: ArenaEffectKind;
      }
    | {
        readonly type: ArenaEffectKind;
        readonly kind?: ArenaEffectKind;
      }
  );

export interface ArenaFrame {
  /** Current clock value in milliseconds, on the same clock as effect times. */
  readonly now: number;
  readonly tick?: number;
  readonly arena: ArenaDefinition;
  readonly players: readonly ArenaPlayer[];
  readonly projectiles: readonly ArenaProjectile[];
  readonly effects: readonly ArenaEffect[];
  readonly localId?: string | null;
}

export type ArenaRendererMode = "webgpu" | "canvas2d";

export interface ArenaRenderer {
  readonly mode: ArenaRendererMode;
  render(frame: ArenaFrame): void;
  /** Reconciles the canvas bitmap with its CSS size and device pixel ratio. */
  resize(): void;
  destroy(): void;
}

export const DEFAULT_ARENA: ArenaDefinition = {
  width: 24,
  height: 14,
  obstacles: [
    { id: "north-west", x: 6, y: 4, radius: 0.72 },
    { id: "north-east", x: 18, y: 4, radius: 0.72 },
    { id: "south-west", x: 6, y: 10, radius: 0.72 },
    { id: "south-east", x: 18, y: 10, radius: 0.72 },
  ],
};
