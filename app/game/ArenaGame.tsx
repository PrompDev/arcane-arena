"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArenaAudio, type ArenaSound } from "./audio";
import { createArenaRenderer } from "./renderer";
import {
  DEFAULT_ARENA,
  type ArenaCameraMode,
  type ArenaCombatDirection,
  type ArenaCombatPhase,
  type ArenaDefinition,
  type ArenaEffect,
  type ArenaEffectKind,
  type ArenaFrame,
  type ArenaPlayer,
  type ArenaProjectile,
  type ArenaRenderer,
} from "./types";

const INPUT_INTERVAL_MS = 1000 / 30;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONFIGURED_SERVER_ORIGIN = process.env.NEXT_PUBLIC_ARENA_SERVER?.trim();

type ConnectionState =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";
type RenderMode = "checking" | "webgpu" | "webgl2" | "unavailable";

interface ClientPlayer extends ArenaPlayer {
  readonly name: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly kills: number;
  readonly deaths: number;
  readonly alive: boolean;
  readonly cooldowns: {
    readonly dash: number;
    readonly primary: number;
    readonly secondary: number;
    readonly utility: number;
  };
}

interface InputMemory {
  keys: Set<string>;
  aimX: number;
  aimY: number;
  primary: boolean;
  secondary: boolean;
  utility: boolean;
  attackHeld: boolean;
  blockHeld: boolean;
  feintQueued: boolean;
  combatDirection: ArenaCombatDirection;
  dashQueued: boolean;
  gamepadDashHeld: boolean;
  gamepadPrimaryHeld: boolean;
  gamepadSecondaryHeld: boolean;
  gamepadUtilityHeld: boolean;
  gamepadAttackHeld: boolean;
  gamepadBlockHeld: boolean;
  gamepadFeintHeld: boolean;
}

interface ParsedSnapshot {
  frame: ArenaFrame;
  players: ClientPlayer[];
  serverTime: number;
  rawEffects: Record<string, unknown>[];
}

const EMPTY_FRAME: ArenaFrame = {
  now: Date.now(),
  tick: 0,
  arena: DEFAULT_ARENA,
  players: [],
  projectiles: [],
  effects: [],
  localId: null,
};

const SPELLS = [
  {
    id: "primary" as const,
    name: "Cinder Shot",
    key: "1",
    note: "Rapid ember",
  },
  {
    id: "secondary" as const,
    name: "Tide Ring",
    key: "2",
    note: "Space control",
  },
  {
    id: "utility" as const,
    name: "Volt Lance",
    key: "3",
    note: "Piercing line",
  },
  {
    id: "dash" as const,
    name: "Phase Dash",
    key: "Space",
    note: "Slip away",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(
  value: unknown,
  fallback: number,
  min = -Number.MAX_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function text(value: unknown, fallback: string, max = 48): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function normalizeRoom(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  return normalized.length === 5 ? normalized : null;
}

function createRoomCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join(
    "",
  );
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 24);
}

function endpointFor(room: string, name: string): string {
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
    window.location.hostname,
  );
  if (!CONFIGURED_SERVER_ORIGIN && !isLocal) {
    throw new Error("NEXT_PUBLIC_ARENA_SERVER is required outside local play");
  }
  const origin = CONFIGURED_SERVER_ORIGIN || "ws://localhost:8787";
  const endpoint = new URL(origin, window.location.href);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  const base = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${base}/room/${encodeURIComponent(room)}`.replace(/\/+/g, "/");
  endpoint.search = "";
  endpoint.searchParams.set("name", name);
  return endpoint.toString();
}

function colorFor(id: string, localId: string | null): string {
  if (id === localId) return "cyan";
  const palette = ["magenta", "gold", "blue"];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

const COMBAT_PHASES = new Set<ArenaCombatPhase>([
  "idle",
  "drawing",
  "releasing",
  "blocking",
  "stunned",
]);
const COMBAT_DIRECTIONS = new Set<ArenaCombatDirection>([
  "up",
  "down",
  "left",
  "right",
]);

function combatPhase(value: unknown): ArenaCombatPhase {
  return typeof value === "string" && COMBAT_PHASES.has(value as ArenaCombatPhase)
    ? (value as ArenaCombatPhase)
    : "idle";
}

function combatDirection(value: unknown): ArenaCombatDirection {
  return typeof value === "string" && COMBAT_DIRECTIONS.has(value as ArenaCombatDirection)
    ? (value as ArenaCombatDirection)
    : "up";
}

function parseSnapshot(
  message: Record<string, unknown>,
  arena: ArenaDefinition,
  localId: string | null,
): ParsedSnapshot {
  const serverTime = finite(message.serverTime, Date.now(), 0);
  const players = (Array.isArray(message.players) ? message.players : [])
    .filter(isRecord)
    .slice(0, 8)
    .map((player, index): ClientPlayer => {
      const id = text(player.id, `player-${index}`, 80);
      const maxHealth = finite(player.maxHealth, 100, 1, 10000);
      const cooldowns = isRecord(player.cooldowns) ? player.cooldowns : {};
      return {
        id,
        name: text(player.name, "Mage", 24),
        x: finite(player.x, arena.width / 2, 0, arena.width),
        y: finite(player.y, arena.height / 2, 0, arena.height),
        vx: finite(player.vx, 0, -100, 100),
        vy: finite(player.vy, 0, -100, 100),
        aimX: finite(player.aimX, 1, -1, 1),
        aimY: finite(player.aimY, 0, -1, 1),
        radius: finite(player.radius, 0.38, 0.1, 2),
        health: finite(player.health, maxHealth, 0, maxHealth),
        maxHealth,
        kills: finite(player.kills, 0, 0, 9999),
        deaths: finite(player.deaths, 0, 0, 9999),
        alive: player.alive !== false,
        respawning: player.alive === false,
        respawnAt: finite(player.respawnAt, 0, 0),
        soakedUntil: finite(player.soakedUntil, 0, 0),
        stunnedUntil: finite(player.stunnedUntil, 0, 0),
        dashUntil: finite(player.dashUntil, 0, 0),
        isDashing: finite(player.dashUntil, 0) > serverTime,
        color: colorFor(id, localId),
        combatPhase: combatPhase(player.combatPhase),
        combatDirection: combatDirection(player.combatDirection),
        combatStartedAt: finite(player.combatStartedAt, 0, 0),
        charge: finite(player.charge, 0, 0, 1),
        weapon: "arcane-blade",
        cooldowns: {
          dash: finite(cooldowns.dash, 0, 0),
          primary: finite(cooldowns.primary, 0, 0),
          secondary: finite(cooldowns.secondary, 0, 0),
          utility: finite(cooldowns.utility, 0, 0),
        },
      };
    });

  const projectiles = (Array.isArray(message.projectiles) ? message.projectiles : [])
    .filter(isRecord)
    .slice(0, 256)
    .map((projectile, index): ArenaProjectile => ({
      id: text(projectile.id, `projectile-${index}`, 100),
      ownerId: text(projectile.ownerId, "", 100) || undefined,
      spell: "cinder-shot",
      x: finite(projectile.x, 0, -4, arena.width + 4),
      y: finite(projectile.y, 0, -4, arena.height + 4),
      vx: finite(projectile.vx, 0, -100, 100),
      vy: finite(projectile.vy, 0, -100, 100),
      radius: finite(projectile.radius, 0.16, 0.04, 2),
      expiresAt: finite(projectile.expiresAt, serverTime + 1000, 0),
    }));

  const rawEffects = (Array.isArray(message.effects) ? message.effects : [])
    .filter(isRecord)
    .slice(0, 256);
  const allowedEffects = new Set([
    "dash",
    "cinder-impact",
    "tide-ring",
    "volt-lance",
    "spawn",
    "death",
    "melee-swing",
    "melee-hit",
    "guard-impact",
    "feint",
  ]);
  const effects = rawEffects
    .filter((effect) => allowedEffects.has(text(effect.type, "", 30)))
    .map((effect, index): ArenaEffect => ({
      id: text(effect.id, `effect-${index}-${finite(effect.createdAt, serverTime)}`, 120),
      type: text(effect.type, "cinder-impact", 30) as ArenaEffectKind,
      ownerId: text(effect.ownerId, "", 100) || undefined,
      x: finite(effect.x, arena.width / 2, -4, arena.width + 4),
      y: finite(effect.y, arena.height / 2, -4, arena.height + 4),
      ...(typeof effect.x2 === "number" && typeof effect.y2 === "number"
        ? {
            x2: finite(effect.x2, arena.width / 2, -4, arena.width + 4),
            y2: finite(effect.y2, arena.height / 2, -4, arena.height + 4),
          }
        : {}),
      radius: finite(effect.radius, 0, 0, 30) || undefined,
      createdAt: finite(effect.createdAt, serverTime - 10, 0),
      expiresAt: finite(effect.expiresAt, serverTime + 250, 0),
    }));

  return {
    serverTime,
    players,
    rawEffects,
    frame: {
      now: serverTime,
      tick: finite(message.tick, 0, 0),
      arena,
      players,
      projectiles,
      effects,
      localId,
    },
  };
}

function connectionCopy(state: ConnectionState): string {
  switch (state) {
    case "connecting":
      return "Opening channel";
    case "online":
      return "Arena linked";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Server offline";
    default:
      return "Ready to connect";
  }
}

function renderCopy(mode: RenderMode): string {
  switch (mode) {
    case "webgpu":
      return "WebGPU active";
    case "webgl2":
      return "WebGL 2 fallback";
    case "unavailable":
      return "Renderer unavailable";
    default:
      return "Checking graphics";
  }
}

function cooldownLabel(until: number, now: number): string {
  const remaining = Math.max(0, until - now);
  return remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "Ready";
}

export default function ArenaGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const frameRef = useRef<ArenaFrame>(EMPTY_FRAME);
  const visualPlayersRef = useRef(new Map<string, { x: number; y: number }>());
  const visualProjectilesRef = useRef(new Map<string, { x: number; y: number }>());
  const arenaRef = useRef<ArenaDefinition>(DEFAULT_ARENA);
  const localIdRef = useRef<string | null>(null);
  const serverOffsetRef = useRef(0);
  const audioRef = useRef<ArenaAudio | null>(null);
  const soundEnabledRef = useRef(true);
  const pointerLockFallbackRef = useRef(false);
  const seenEffectsRef = useRef(new Set<string>());
  const aliveRef = useRef(new Map<string, boolean>());
  const inputRef = useRef<InputMemory>({
    keys: new Set(),
    aimX: 1,
    aimY: 0,
    primary: false,
    secondary: false,
    utility: false,
    attackHeld: false,
    blockHeld: false,
    feintQueued: false,
    combatDirection: "up",
    dashQueued: false,
    gamepadDashHeld: false,
    gamepadPrimaryHeld: false,
    gamepadSecondaryHeld: false,
    gamepadUtilityHeld: false,
    gamepadAttackHeld: false,
    gamepadBlockHeld: false,
    gamepadFeintHeld: false,
  });

  const [roomCode, setRoomCode] = useState("-----");
  const [invited, setInvited] = useState(false);
  const [displayName, setDisplayName] = useState("Mage");
  const [committedName, setCommittedName] = useState("Mage");
  const [entered, setEntered] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [renderMode, setRenderMode] = useState<RenderMode>("checking");
  const [players, setPlayers] = useState<ClientPlayer[]>([]);
  const [localId, setLocalId] = useState<string | null>(null);
  const [serverNow, setServerNow] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("Copy invite");
  const [networkNote, setNetworkNote] = useState("");
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [cameraMode, setCameraMode] = useState<ArenaCameraMode>("third-person");
  const [pointerLocked, setPointerLocked] = useState(false);

  const playSound = useCallback((sound: ArenaSound) => {
    if (soundEnabledRef.current) audioRef.current?.play(sound);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      const existing = normalizeRoom(url.searchParams.get("room"));
      const nextRoom = existing || createRoomCode();
      if (!existing) {
        url.searchParams.set("room", nextRoom);
        window.history.replaceState({}, "", url);
      }
      setInvited(Boolean(existing));
      setRoomCode(nextRoom);

      const savedName = cleanName(
        window.localStorage.getItem("arcane-arena-name") || "",
      );
      if (savedName) {
        setDisplayName(savedName);
        setCommittedName(savedName);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;

    void createArenaRenderer(canvas)
      .then((renderer) => {
        if (!active) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        setRenderMode(renderer.mode);
        let previousRenderAt = performance.now();
        const render = (renderAt: number) => {
          const delta = Math.min(50, Math.max(1, renderAt - previousRenderAt));
          previousRenderAt = renderAt;
          const now = Date.now() + serverOffsetRef.current;
          const authoritative = frameRef.current;
          const livePlayerIds = new Set<string>();
          const visualPlayers = authoritative.players.map((player) => {
            livePlayerIds.add(player.id);
            if (player.id === localIdRef.current) {
              const position = { x: player.x, y: player.y };
              visualPlayersRef.current.set(player.id, position);
              return { ...player, ...position };
            }
            const previous = visualPlayersRef.current.get(player.id);
            const distance = previous
              ? Math.hypot(player.x - previous.x, player.y - previous.y)
              : Number.POSITIVE_INFINITY;
            const blend = 1 - Math.exp(-delta / 58);
            const position =
              !previous || distance > Math.max(authoritative.arena.width * 0.2, 4)
                ? { x: player.x, y: player.y }
                : {
                    x: previous.x + (player.x - previous.x) * blend,
                    y: previous.y + (player.y - previous.y) * blend,
                  };
            visualPlayersRef.current.set(player.id, position);
            return { ...player, ...position };
          });
          for (const id of visualPlayersRef.current.keys()) {
            if (!livePlayerIds.has(id)) visualPlayersRef.current.delete(id);
          }

          const liveProjectileIds = new Set<string>();
          const visualProjectiles = authoritative.projectiles.map((projectile) => {
            liveProjectileIds.add(projectile.id);
            const previous = visualProjectilesRef.current.get(projectile.id);
            const blend = 1 - Math.exp(-delta / 30);
            const position = previous
              ? {
                  x: previous.x + (projectile.x - previous.x) * blend,
                  y: previous.y + (projectile.y - previous.y) * blend,
                }
              : { x: projectile.x, y: projectile.y };
            visualProjectilesRef.current.set(projectile.id, position);
            return {
              ...projectile,
              prevX: previous?.x,
              prevY: previous?.y,
              ...position,
            };
          });
          for (const id of visualProjectilesRef.current.keys()) {
            if (!liveProjectileIds.has(id)) visualProjectilesRef.current.delete(id);
          }

          renderer.render({
            ...authoritative,
            now,
            players: visualPlayers,
            projectiles: visualProjectiles,
          });
          animationFrame = window.requestAnimationFrame(render);
        };
        renderer.resize();
        animationFrame = window.requestAnimationFrame(render);
        observer = new ResizeObserver(() => renderer.resize());
        observer.observe(canvas);
      })
      .catch((error) => {
        console.error("Unable to initialize the 3D arena", error);
        setRenderMode("unavailable");
      });

    return () => {
      active = false;
      window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(
    () => () => {
      audioRef.current?.destroy();
      audioRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!entered || roomCode === "-----") return;
    let disposed = false;
    let retryTimer = 0;
    let pingTimer = 0;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      setConnection(attempts ? "reconnecting" : "connecting");
      setNetworkNote(attempts ? "The channel dropped. Holding your place…" : "");
      let socket: WebSocket;
      try {
        socket = new WebSocket(endpointFor(roomCode, committedName));
      } catch {
        setConnection("offline");
        setNetworkNote(
          CONFIGURED_SERVER_ORIGIN
            ? "The arena address is unavailable."
            : "Online play needs a configured arena server.",
        );
        return;
      }
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        attempts = 0;
        setConnection("online");
        setNetworkNote("");
        window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
          }
        }, 2000);
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || event.data.length > 1_000_000) return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!isRecord(message)) return;

        if (message.type === "welcome") {
          const id = text(message.id, "", 100);
          if (id) {
            localIdRef.current = id;
            setLocalId(id);
          }
          const serverTime = finite(message.serverTime, Date.now(), 0);
          const welcomeOffset = serverTime - Date.now();
          serverOffsetRef.current = serverOffsetRef.current
            ? serverOffsetRef.current * 0.75 + welcomeOffset * 0.25
            : welcomeOffset;
          if (isRecord(message.arena)) {
            const pillars = Array.isArray(message.arena.pillars)
              ? message.arena.pillars.filter(isRecord).slice(0, 32)
              : [];
            arenaRef.current = {
              width: finite(message.arena.width, 24, 8, 100),
              height: finite(message.arena.height, 14, 6, 100),
              obstacles: pillars.map((pillar, index) => ({
                id: `pillar-${index}`,
                x: finite(pillar.x, 0, 0, 100),
                y: finite(pillar.y, 0, 0, 100),
                r: finite(pillar.r, 0.7, 0.1, 8),
              })),
            };
          }
          frameRef.current = {
            ...frameRef.current,
            arena: arenaRef.current,
            localId: id || null,
          };
          return;
        }

        if (message.type === "snapshot") {
          const snapshot = parseSnapshot(message, arenaRef.current, localIdRef.current);
          frameRef.current = snapshot.frame;
          setPlayers(snapshot.players);
          setServerNow(snapshot.serverTime);

          const explicitTransitions = new Set<string>();
          for (const effect of snapshot.rawEffects) {
            const id = text(effect.id, "", 120);
            const type = text(effect.type, "", 30);
            if (!id || seenEffectsRef.current.has(id)) continue;
            seenEffectsRef.current.add(id);
            const ownerId = text(effect.ownerId, "", 100);
            if (type === "death" || type === "spawn") {
              explicitTransitions.add(`${type}:${ownerId}`);
            }
            if (type === "cinder-impact") playSound("hit");
            if (ownerId !== localIdRef.current && type === "dash") playSound("dash");
            if (ownerId !== localIdRef.current && type === "tide-ring") playSound("tide");
            if (ownerId !== localIdRef.current && type === "volt-lance") playSound("volt");
            if (type === "death") playSound("defeat");
            if (type === "spawn") playSound("respawn");
          }
          if (seenEffectsRef.current.size > 512) {
            seenEffectsRef.current = new Set(
              Array.from(seenEffectsRef.current).slice(-256),
            );
          }
          for (const player of snapshot.players) {
            const previousAlive = aliveRef.current.get(player.id);
            if (
              previousAlive === true &&
              !player.alive &&
              !explicitTransitions.has(`death:${player.id}`)
            ) {
              playSound("defeat");
            }
            if (
              previousAlive === false &&
              player.alive &&
              !explicitTransitions.has(`spawn:${player.id}`)
            ) {
              playSound("respawn");
            }
            aliveRef.current.set(player.id, player.alive);
          }
          return;
        }

        if (message.type === "pong") {
          const clientTime = finite(message.clientTime, Date.now(), 0);
          const receivedAt = Date.now();
          const roundTrip = Math.max(0, receivedAt - clientTime);
          const pongServerTime = finite(message.serverTime, 0, 0);
          if (pongServerTime) {
            const offsetSample = pongServerTime - (clientTime + receivedAt) / 2;
            serverOffsetRef.current = serverOffsetRef.current
              ? serverOffsetRef.current * 0.85 + offsetSample * 0.15
              : offsetSample;
          }
          setLatency(Math.round(roundTrip));
        }
      });

      socket.addEventListener("error", () => {
        setNetworkNote("Couldn’t reach the arena server.");
      });

      socket.addEventListener("close", () => {
        window.clearInterval(pingTimer);
        if (disposed) return;
        setConnection("reconnecting");
        attempts += 1;
        const delay = Math.min(8000, 650 * 2 ** Math.min(attempts, 4));
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      socketRef.current?.close(1000, "Left arena");
      socketRef.current = null;
    };
  }, [committedName, entered, playSound, roomCode]);

  useEffect(() => {
    if (!entered) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const input = inputRef.current;
    let sequence = 0;
    let lastGamepadState = false;

    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const code = event.code;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "ShiftLeft", "ShiftRight", "KeyQ", "KeyV", "Digit1", "Digit2", "Digit3"].includes(code)) {
        event.preventDefault();
      }
      input.keys.add(code);
      if ((code === "Space" || code.startsWith("Shift")) && !event.repeat) {
        input.dashQueued = true;
        playSound("dash");
      }
      if (code === "KeyQ" && !event.repeat) input.feintQueued = true;
      if (code === "Digit1" && !event.repeat) playSound("cinder");
      if (code === "Digit2" && !event.repeat) playSound("tide");
      if (code === "Digit3" && !event.repeat) playSound("volt");
      if (code === "KeyV" && !event.repeat) {
        const renderer = rendererRef.current;
        if (renderer) {
          const next = renderer.getCameraMode() === "third-person"
            ? "first-person"
            : "third-person";
          renderer.setCameraMode(next);
          setCameraMode(next);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => input.keys.delete(event.code);
    const sendStop = () => {
      sequence = (sequence + 1) % 1_000_000_000;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "input",
            seq: sequence,
            moveX: 0,
            moveY: 0,
            aimX: finite(input.aimX, 1, -1, 1),
            aimY: finite(input.aimY, 0, -1, 1),
            dash: false,
            primary: false,
            secondary: false,
            utility: false,
            attackHeld: false,
            blockHeld: false,
            feint: false,
            combatDirection: input.combatDirection,
          }),
        );
      }
    };
    const onBlur = () => {
      input.keys.clear();
      input.primary = false;
      input.secondary = false;
      input.utility = false;
      input.attackHeld = false;
      input.blockHeld = false;
      input.feintQueued = false;
      input.dashQueued = false;
      sendStop();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onBlur();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (
        document.pointerLockElement !== canvas &&
        !pointerLockFallbackRef.current
      ) return;
      rendererRef.current?.addLookDelta(event.movementX, event.movementY);
      const horizontal = Math.abs(event.movementX);
      const vertical = Math.abs(event.movementY);
      if (Math.max(horizontal, vertical) >= 3) {
        input.combatDirection = horizontal > vertical
          ? event.movementX > 0 ? "right" : "left"
          : event.movementY > 0 ? "down" : "up";
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      canvas.focus({ preventScroll: true });
      if (
        document.pointerLockElement !== canvas &&
        !pointerLockFallbackRef.current
      ) {
        void canvas.requestPointerLock().catch(() => {
          pointerLockFallbackRef.current = true;
          setPointerLocked(true);
        });
        event.preventDefault();
        return;
      }
      if (event.button === 0) {
        input.attackHeld = true;
        playSound("swing");
      }
      if (event.button === 2) {
        input.blockHeld = true;
        playSound("block");
      }
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 0) input.attackHeld = false;
      if (event.button === 2) input.blockHeld = false;
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onPointerLockChange = () => setPointerLocked(
      document.pointerLockElement === canvas || pointerLockFallbackRef.current,
    );

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);

    const inputTimer = window.setInterval(() => {
      let moveX =
        Number(input.keys.has("KeyD") || input.keys.has("ArrowRight")) -
        Number(input.keys.has("KeyA") || input.keys.has("ArrowLeft"));
      let moveY =
        Number(input.keys.has("KeyS") || input.keys.has("ArrowDown")) -
        Number(input.keys.has("KeyW") || input.keys.has("ArrowUp"));
      let primary = input.keys.has("Digit1");
      let secondary = input.keys.has("Digit2");
      let utility = input.keys.has("Digit3");
      let attackHeld = input.attackHeld;
      let blockHeld = input.blockHeld;
      let feint = input.feintQueued;

      const gamepad = navigator.getGamepads?.().find(Boolean) || null;
      const hasGamepad = Boolean(gamepad);
      if (hasGamepad !== lastGamepadState) {
        lastGamepadState = hasGamepad;
        setGamepadConnected(hasGamepad);
      }
      if (gamepad) {
        const deadzone = (value: number) => (Math.abs(value) > 0.18 ? value : 0);
        const gameMoveX = deadzone(gamepad.axes[0] || 0);
        const gameMoveY = deadzone(gamepad.axes[1] || 0);
        if (gameMoveX || gameMoveY) {
          moveX = gameMoveX;
          moveY = gameMoveY;
        }
        const gameAimX = deadzone(gamepad.axes[2] || 0);
        const gameAimY = deadzone(gamepad.axes[3] || 0);
        if (gameAimX || gameAimY) {
          rendererRef.current?.addLookDelta(gameAimX * 15, gameAimY * 12);
          input.combatDirection = Math.abs(gameAimX) > Math.abs(gameAimY)
            ? gameAimX > 0 ? "right" : "left"
            : gameAimY > 0 ? "down" : "up";
        }
        const padAttack = Boolean(gamepad.buttons[7]?.pressed);
        const padBlock = Boolean(gamepad.buttons[6]?.pressed);
        const padPrimary = Boolean(gamepad.buttons[0]?.pressed);
        const padSecondary = Boolean(gamepad.buttons[1]?.pressed);
        const padFeint = Boolean(gamepad.buttons[2]?.pressed);
        const padUtility = Boolean(gamepad.buttons[3]?.pressed);
        const padDash = Boolean(gamepad.buttons[4]?.pressed || gamepad.buttons[5]?.pressed);
        if (padPrimary && !input.gamepadPrimaryHeld) playSound("cinder");
        if (padSecondary && !input.gamepadSecondaryHeld) playSound("tide");
        if (padUtility && !input.gamepadUtilityHeld) playSound("volt");
        if (padAttack && !input.gamepadAttackHeld) playSound("swing");
        if (padBlock && !input.gamepadBlockHeld) playSound("block");
        if (padDash && !input.gamepadDashHeld) {
          input.dashQueued = true;
          playSound("dash");
        }
        input.gamepadPrimaryHeld = padPrimary;
        input.gamepadSecondaryHeld = padSecondary;
        input.gamepadUtilityHeld = padUtility;
        input.gamepadAttackHeld = padAttack;
        input.gamepadBlockHeld = padBlock;
        if (padFeint && !input.gamepadFeintHeld) feint = true;
        input.gamepadFeintHeld = padFeint;
        input.gamepadDashHeld = padDash;
        primary ||= padPrimary;
        secondary ||= padSecondary;
        utility ||= padUtility;
        attackHeld ||= padAttack;
        blockHeld ||= padBlock;
      }

      const moveLength = Math.hypot(moveX, moveY);
      if (moveLength > 1) {
        moveX /= moveLength;
        moveY /= moveLength;
      }
      const basis = rendererRef.current?.getControlBasis();
      if (basis) {
        input.aimX = basis.aim.x;
        input.aimY = basis.aim.y;
        const strafe = moveX;
        const forward = -moveY;
        moveX = basis.right.x * strafe + basis.forward.x * forward;
        moveY = basis.right.y * strafe + basis.forward.y * forward;
      }
      sequence = (sequence + 1) % 1_000_000_000;
      const packet = {
        type: "input",
        seq: sequence,
        moveX: finite(moveX, 0, -1, 1),
        moveY: finite(moveY, 0, -1, 1),
        aimX: finite(input.aimX, 1, -1, 1),
        aimY: finite(input.aimY, 0, -1, 1),
        dash: input.dashQueued,
        primary: Boolean(primary),
        secondary: Boolean(secondary),
        utility: Boolean(utility),
        attackHeld: Boolean(attackHeld),
        blockHeld: Boolean(blockHeld),
        feint: Boolean(feint),
        combatDirection: input.combatDirection,
      };
      input.dashQueued = false;
      input.feintQueued = false;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(packet));
      }
    }, INPUT_INTERVAL_MS);

    return () => {
      window.clearInterval(inputTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      onBlur();
    };
  }, [entered, playSound]);

  const localPlayer = useMemo(
    () => players.find((player) => player.id === localId) || null,
    [localId, players],
  );
  const rankedPlayers = useMemo(
    () => [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths),
    [players],
  );
  const health = localPlayer?.health ?? 100;
  const maxHealth = localPlayer?.maxHealth ?? 100;
  const healthPercent = Math.max(0, Math.min(100, (health / maxHealth) * 100));

  const enterArena = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = cleanName(displayName) || "Mage";
    setDisplayName(name);
    setCommittedName(name);
    window.localStorage.setItem("arcane-arena-name", name);
    if (!audioRef.current) audioRef.current = new ArenaAudio();
    void audioRef.current.unlock();
    setEntered(true);
    setConnection("connecting");
    window.setTimeout(() => canvasRef.current?.focus({ preventScroll: true }), 0);
  };

  const leaveArena = () => {
    if (document.pointerLockElement === canvasRef.current) document.exitPointerLock();
    setEntered(false);
    setConnection("idle");
    setPlayers([]);
    setLocalId(null);
    localIdRef.current = null;
    frameRef.current = { ...EMPTY_FRAME, arena: arenaRef.current };
    visualPlayersRef.current.clear();
    visualProjectilesRef.current.clear();
    aliveRef.current.clear();
    seenEffectsRef.current.clear();
    setPointerLocked(false);
    pointerLockFallbackRef.current = false;
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyStatus("Invite copied");
    } catch {
      setCopyStatus("Copy the address bar");
    }
    window.setTimeout(() => setCopyStatus("Copy invite"), 1800);
  };

  const toggleSound = () => {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    if (next) {
      void audioRef.current?.unlock();
      playSound("respawn");
    }
  };

  const toggleCamera = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const next = renderer.getCameraMode() === "third-person"
      ? "first-person"
      : "third-person";
    renderer.setCameraMode(next);
    setCameraMode(next);
  };

  const capturePointer = () => {
    canvasRef.current?.focus({ preventScroll: true });
    void canvasRef.current?.requestPointerLock().catch(() => {
      pointerLockFallbackRef.current = true;
      setPointerLocked(true);
    });
  };

  return (
    <div className={`arena-app ${entered ? "is-playing" : "is-lobby"}`} data-product="arcane-arena">
      <a className="skip-link" href="#arena-main">Skip to arena controls</a>
      <canvas
        ref={canvasRef}
        className="arena-canvas"
        aria-label="Arcane Arena 3D multiplayer battlemage duel"
        role="img"
        tabIndex={entered ? 0 : -1}
      />
      <div className="arena-vignette" aria-hidden="true" />

      <header className="arena-header">
        <div className="brand-lockup" aria-label="Arcane Arena">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Arcane</b> Arena</span>
        </div>
        <div className="system-status" aria-label="System status">
          <span className={`status-chip status-${connection}`}>
            <i aria-hidden="true" />{connectionCopy(connection)}
          </span>
          <span className={`status-chip gpu-${renderMode}`}>
            <i aria-hidden="true" />{renderCopy(renderMode)}
          </span>
        </div>
      </header>

      <main id="arena-main">
        {!entered ? (
          <section className="lobby-shell" aria-labelledby="arena-title">
            <div className="lobby-copy">
              <p className="eyebrow"><span>3D multiplayer battlemage duels</span><i /></p>
              <h1 id="arena-title"><span>Enter the</span> Arcane Arena</h1>
              <p className="lobby-lede">
                Read the guard. Feint the counter. Break the line with steel,
                movement, and three elemental arcana.
              </p>
              <div className="lobby-spells" aria-label="Your arcana">
                <span><i className="spell-dot cinder" />Cinder</span>
                <span><i className="spell-dot tide" />Tide</span>
                <span><i className="spell-dot volt" />Volt</span>
              </div>
            </div>

            <form className="join-card" onSubmit={enterArena}>
              <div className="join-card-heading">
                <div>
                  <p>{invited ? "Invitation found" : "Private duel room"}</p>
                  <h2>{invited ? "Join the circle" : "Open the circle"}</h2>
                </div>
                <span className="room-badge" aria-label={`Room code ${roomCode}`}>
                  <small>Room</small>{roomCode}
                </span>
              </div>

              <label className="name-field">
                <span>Display name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={24}
                  autoComplete="nickname"
                  spellCheck="false"
                  aria-describedby="name-note"
                />
                <small id="name-note">2–24 characters · visible to this room</small>
              </label>

              <button
                className="enter-button"
                type="submit"
                disabled={roomCode === "-----" || cleanName(displayName).length < 2}
              >
                <span>{invited ? "Join arena" : "Enter arena"}</span>
                <i aria-hidden="true">→</i>
              </button>
              <button className="invite-button" type="button" onClick={copyInvite}>
                <span aria-hidden="true">⧉</span>{copyStatus}
              </button>

              <div className="join-meta">
                <span><i className="meta-key">WASD</i> Move</span>
                <span><i className="meta-key">Mouse</i> Look + blade</span>
                <span><i className="meta-key">Pad</i> Supported</span>
              </div>
            </form>
          </section>
        ) : (
          <section className="game-interface" aria-label="Arena heads-up display">
            <aside className="score-panel glass-panel" aria-labelledby="score-title">
              <div className="panel-heading">
                <div><p>Room {roomCode}</p><h2 id="score-title">Duelists</h2></div>
                <span>{players.length}/4</span>
              </div>
              {rankedPlayers.length ? (
                <ol className="score-list">
                  {rankedPlayers.map((player, index) => (
                    <li key={player.id} className={player.id === localId ? "is-local" : ""}>
                      <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                      <i className={`player-gem player-${player.color}`} aria-hidden="true" />
                      <span className="player-name">{player.name}<small>{player.alive ? "In the circle" : "Reforming"}</small></span>
                      <strong>{player.kills}<small>KOs</small></strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-score">Waiting for the circle to answer…</p>
              )}
              <div className="panel-footer">
                <span>{latency === null ? "Measuring ping" : `${latency} ms ping`}</span>
                <span>{gamepadConnected ? "Gamepad active" : "Keyboard + mouse"}</span>
              </div>
            </aside>

            <div className="match-tools">
              <button type="button" onClick={toggleSound} aria-pressed={soundEnabled}>
                {soundEnabled ? "Sound on" : "Sound off"}
              </button>
              <button type="button" onClick={toggleCamera} aria-label="Toggle first and third person camera">
                {cameraMode === "third-person" ? "Third person" : "First person"}
              </button>
              <button type="button" onClick={copyInvite}>Invite</button>
              <button type="button" onClick={leaveArena}>Leave</button>
            </div>

            <div className={`combat-reticle direction-${localPlayer?.combatDirection ?? "up"}`} aria-hidden="true">
              <i /><span />
            </div>

            {!pointerLocked ? (
              <button className="capture-pointer" type="button" onClick={capturePointer}>
                <strong>Take control</strong>
                <span>Click to capture the mouse · Esc releases it</span>
              </button>
            ) : null}

            <details className="help-panel glass-panel">
              <summary><span>How to duel</span><i>?</i></summary>
              <div className="help-body">
                <p><kbd>WASD</kbd><span>Move</span></p>
                <p><kbd>Mouse</kbd><span>Look + choose angle</span></p>
                <p><kbd>LMB</kbd><span>Draw / release blade</span></p>
                <p><kbd>RMB</kbd><span>Directional guard</span></p>
                <p><kbd>Q</kbd><span>Feint</span></p>
                <p><kbd>1 / 2 / 3</kbd><span>Cinder / Tide / Volt</span></p>
                <p><kbd>Space</kbd><span>Phase Dash</span></p>
                <p><kbd>V</kbd><span>Toggle camera</span></p>
                <small>Gamepad: sticks move/look, triggers attack/guard, face buttons cast or feint.</small>
              </div>
            </details>

            <div className="combat-hud">
              {!localPlayer?.alive && localPlayer ? (
                <div className="respawn-callout" role="status">
                  Reforming in {Math.max(0, (Number(localPlayer.respawnAt) - serverNow) / 1000).toFixed(1)}
                </div>
              ) : null}
              <div className={`blade-state phase-${localPlayer?.combatPhase ?? "idle"}`}>
                <span><i /> Arcane blade</span>
                <strong>{(localPlayer?.combatPhase ?? "idle").replace("ing", "")}</strong>
                <small>{localPlayer?.combatDirection ?? "up"}</small>
                <b style={{ width: `${Math.round((localPlayer?.charge ?? 0) * 100)}%` }} />
              </div>
              <div className="health-cluster">
                <div className="health-copy"><span>Vital weave</span><strong>{Math.ceil(health)}<small> / {maxHealth}</small></strong></div>
                <div
                  className="health-track"
                  role="progressbar"
                  aria-label="Health"
                  aria-valuemin={0}
                  aria-valuemax={maxHealth}
                  aria-valuenow={health}
                ><i style={{ width: `${healthPercent}%` }} /></div>
              </div>
              <div className="spell-deck" aria-label="Spell cooldowns">
                {SPELLS.map((spell) => {
                  const until = localPlayer?.cooldowns[spell.id] || 0;
                  const ready = until <= serverNow;
                  return (
                    <div className={`spell-card spell-${spell.id} ${ready ? "is-ready" : "is-cooling"}`} key={spell.id}>
                      <span className="spell-rune" aria-hidden="true"><i /><i /></span>
                      <span className="spell-copy"><strong>{spell.name}</strong><small>{spell.note}</small></span>
                      <span className="spell-key">{spell.key}</span>
                      <span className="cooldown-readout">{cooldownLabel(until, serverNow)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {connection !== "online" ? (
              <div className="network-callout" role="status">
                <span className="signal-bars" aria-hidden="true"><i /><i /><i /></span>
                <strong>{connectionCopy(connection)}</strong>
                <small>{networkNote || "Connecting to your duel room…"}</small>
              </div>
            ) : null}
          </section>
        )}
      </main>
      <p className="sr-only" aria-live="polite">
        {connectionCopy(connection)}. {copyStatus !== "Copy invite" ? copyStatus : ""}
      </p>
    </div>
  );
}
