import { DurableObject } from "cloudflare:workers";

import {
  ARENA_DESCRIPTION,
  PERSIST_EVERY_TICKS,
  TICK_INTERVAL_MS,
  addPlayer,
  applyPlayerInput,
  buildSnapshot,
  createArenaState,
  removePlayer,
  restoreArenaState,
  serializeArenaState,
  stepArena,
  type ArenaState,
} from "./game";
import {
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  parseClientMessage,
  parseConnectionAttachment,
  sanitizeName,
  sanitizeRoom,
  type ConnectionAttachment,
  type PongMessage,
  type WelcomeMessage,
} from "./protocol";
import { applySqlMigrations } from "./sql-migrations";

const MESSAGE_RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 120;
const MAX_INVALID_MESSAGES = 8;

interface ConnectionRuntime {
  attachment: ConnectionAttachment;
  windowStartedAt: number;
  messagesInWindow: number;
  invalidMessages: number;
}

type StoredArenaRow = {
  room: string;
  state_json: string;
};

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function roomFromRequest(request: Request): string | null {
  const pathname = new URL(request.url).pathname;
  const match = /^\/room\/([^/]+)$/.exec(pathname);
  if (match?.[1] === undefined) {
    return null;
  }

  try {
    return sanitizeRoom(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ArenaRoom extends DurableObject<Env> {
  private state: ArenaState = createArenaState("");
  private readonly connections = new Map<WebSocket, ConnectionRuntime>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void this.ctx.blockConcurrencyWhile(async () => {
      applySqlMigrations(this.ctx.storage);
      this.loadStoredState();
      this.restoreConnections();
      if (this.connections.size > 0) {
        this.startTickLoop();
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "WebSocket upgrade required" }, 426);
    }

    const room = roomFromRequest(request);
    if (room === null) {
      return jsonResponse({ error: "Invalid room" }, 400);
    }

    if (this.state.room.length > 0 && this.state.room !== room) {
      return jsonResponse({ error: "Room identity conflict" }, 409);
    }

    this.state.room = room;
    this.removeClosedConnections();
    if (this.connections.size >= MAX_PLAYERS) {
      return jsonResponse({ error: "Room is full", maxPlayers: MAX_PLAYERS }, 503);
    }

    const now = Date.now();
    const name = sanitizeName(new URL(request.url).searchParams.get("name"));
    const playerId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      version: 1,
      playerId,
      room,
      name,
      joinedAt: now,
      lastSeq: -1,
    };

    this.ctx.acceptWebSocket(server, [room, `player:${playerId}`]);
    server.serializeAttachment(attachment);
    this.connections.set(server, {
      attachment,
      windowStartedAt: now,
      messagesInWindow: 0,
      invalidMessages: 0,
    });
    addPlayer(this.state, playerId, name, now);

    const welcome: WelcomeMessage = {
      type: "welcome",
      id: playerId,
      room,
      serverTime: now,
      arena: ARENA_DESCRIPTION,
    };

    try {
      server.send(JSON.stringify(welcome));
      server.send(JSON.stringify(buildSnapshot(this.state, now)));
    } catch (error) {
      this.detachConnection(server, false);
      server.close(1011, "Unable to initialize connection");
      this.persistState(now);
      console.error(
        JSON.stringify({
          message: "websocket initialization failed",
          room,
          error: errorMessage(error),
        }),
      );
      return jsonResponse({ error: "Unable to initialize connection" }, 500);
    }

    this.persistState(now);
    this.startTickLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    const now = Date.now();
    const connection = this.connectionFor(webSocket, now);
    if (connection === null) {
      this.closeConnection(webSocket, 1008, "Missing connection state");
      return;
    }

    if (!this.consumeMessageBudget(connection, now)) {
      this.closeConnection(webSocket, 1008, "Message rate exceeded");
      return;
    }

    if (typeof message !== "string") {
      this.closeConnection(webSocket, 1003, "Text messages only");
      return;
    }

    if (
      message.length > MAX_MESSAGE_BYTES ||
      new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES
    ) {
      this.closeConnection(webSocket, 1009, "Message too large");
      return;
    }

    const parsed = parseClientMessage(message);
    if (parsed === null) {
      connection.invalidMessages += 1;
      if (connection.invalidMessages >= MAX_INVALID_MESSAGES) {
        this.closeConnection(webSocket, 1008, "Too many invalid messages");
      }
      return;
    }

    connection.invalidMessages = 0;
    if (parsed.type === "ping") {
      const pong: PongMessage = {
        type: "pong",
        clientTime: parsed.clientTime,
        serverTime: now,
      };
      webSocket.send(JSON.stringify(pong));
      return;
    }

    const player = this.state.players.get(connection.attachment.playerId);
    if (player === undefined) {
      this.closeConnection(webSocket, 1008, "Player state missing");
      return;
    }

    if (applyPlayerInput(player, parsed, now)) {
      connection.attachment = {
        ...connection.attachment,
        lastSeq: player.lastSeq,
      };
      webSocket.serializeAttachment(connection.attachment);
    }

    this.startTickLoop();
  }

  override webSocketClose(
    webSocket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.detachConnection(webSocket, true);
  }

  override webSocketError(webSocket: WebSocket, error: unknown): void {
    const attachment = parseConnectionAttachment(webSocket.deserializeAttachment());
    console.error(
      JSON.stringify({
        message: "arena websocket error",
        room: attachment?.room ?? this.state.room,
        playerId: attachment?.playerId ?? "unknown",
        error: errorMessage(error),
      }),
    );
    this.closeConnection(webSocket, 1011, "Connection error");
  }

  private loadStoredState(): void {
    const rows = this.ctx.storage.sql
      .exec<StoredArenaRow>(
        "SELECT room, state_json FROM arena_state WHERE singleton = 1",
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      return;
    }

    const room = sanitizeRoom(row.room);
    if (room === null) {
      return;
    }
    this.state = restoreArenaState(room, row.state_json, Date.now());
  }

  private restoreConnections(): void {
    const now = Date.now();
    const connectedPlayerIds = new Set<string>();

    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = parseConnectionAttachment(webSocket.deserializeAttachment());
      if (
        attachment === null ||
        (this.state.room.length > 0 && attachment.room !== this.state.room) ||
        this.connections.size >= MAX_PLAYERS
      ) {
        webSocket.close(1008, "Invalid restored connection");
        continue;
      }

      this.state.room = attachment.room;
      const player = addPlayer(this.state, attachment.playerId, attachment.name, now);
      player.lastSeq = Math.max(player.lastSeq, attachment.lastSeq);
      player.input.moveX = 0;
      player.input.moveY = 0;
      player.input.dashQueued = false;
      player.input.primaryQueued = false;
      player.input.secondaryQueued = false;
      player.input.utilityQueued = false;

      connectedPlayerIds.add(attachment.playerId);
      this.connections.set(webSocket, {
        attachment,
        windowStartedAt: now,
        messagesInWindow: 0,
        invalidMessages: 0,
      });
    }

    for (const playerId of [...this.state.players.keys()]) {
      if (!connectedPlayerIds.has(playerId)) {
        removePlayer(this.state, playerId);
      }
    }

    if (this.state.room.length > 0) {
      this.persistState(now);
    }
  }

  private connectionFor(webSocket: WebSocket, now: number): ConnectionRuntime | null {
    const existing = this.connections.get(webSocket);
    if (existing !== undefined) {
      return existing;
    }

    const attachment = parseConnectionAttachment(webSocket.deserializeAttachment());
    if (
      attachment === null ||
      (this.state.room.length > 0 && attachment.room !== this.state.room) ||
      this.connections.size >= MAX_PLAYERS
    ) {
      return null;
    }

    this.state.room = attachment.room;
    const player = addPlayer(this.state, attachment.playerId, attachment.name, now);
    player.lastSeq = Math.max(player.lastSeq, attachment.lastSeq);
    const restored: ConnectionRuntime = {
      attachment,
      windowStartedAt: now,
      messagesInWindow: 0,
      invalidMessages: 0,
    };
    this.connections.set(webSocket, restored);
    return restored;
  }

  private consumeMessageBudget(connection: ConnectionRuntime, now: number): boolean {
    if (now - connection.windowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
      connection.windowStartedAt = now;
      connection.messagesInWindow = 0;
    }

    connection.messagesInWindow += 1;
    return connection.messagesInWindow <= MAX_MESSAGES_PER_WINDOW;
  }

  private startTickLoop(): void {
    if (this.tickTimer !== null || this.connections.size === 0) {
      return;
    }

    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => {
      try {
        this.runTick();
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "arena tick failed",
            room: this.state.room,
            tick: this.state.tick,
            error: errorMessage(error),
          }),
        );
      }
    }, TICK_INTERVAL_MS);
  }

  private stopTickLoop(): void {
    if (this.tickTimer === null) {
      return;
    }
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.lastTickAt = null;
  }

  private runTick(): void {
    if (this.connections.size === 0) {
      this.stopTickLoop();
      return;
    }

    const now = Date.now();
    const elapsedMs =
      this.lastTickAt === null ? TICK_INTERVAL_MS : Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    stepArena(this.state, now, elapsedMs);
    const payload = JSON.stringify(buildSnapshot(this.state, now));
    const disconnected: WebSocket[] = [];

    for (const webSocket of this.connections.keys()) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        disconnected.push(webSocket);
        continue;
      }

      try {
        webSocket.send(payload);
      } catch {
        disconnected.push(webSocket);
      }
    }

    for (const webSocket of disconnected) {
      this.detachConnection(webSocket, false);
    }

    if (this.state.tick % PERSIST_EVERY_TICKS === 0 || this.connections.size === 0) {
      this.persistState(now);
    }
    if (this.connections.size === 0) {
      this.stopTickLoop();
    }
  }

  private removeClosedConnections(): void {
    for (const webSocket of [...this.connections.keys()]) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        this.detachConnection(webSocket, false);
      }
    }
  }

  private closeConnection(webSocket: WebSocket, code: number, reason: string): void {
    try {
      webSocket.close(code, reason);
    } finally {
      this.detachConnection(webSocket, true);
    }
  }

  private detachConnection(webSocket: WebSocket, shouldPersist: boolean): void {
    const runtime = this.connections.get(webSocket);
    const attachment =
      runtime?.attachment ?? parseConnectionAttachment(webSocket.deserializeAttachment());
    this.connections.delete(webSocket);

    if (attachment !== null) {
      removePlayer(this.state, attachment.playerId);
    }

    if (shouldPersist && this.state.room.length > 0) {
      this.persistState(Date.now());
    }
    if (this.connections.size === 0) {
      this.stopTickLoop();
    }
  }

  private persistState(now: number): void {
    if (this.state.room.length === 0) {
      return;
    }

    const serialized = serializeArenaState(this.state, now);
    this.ctx.storage.sql.exec(
      `
        INSERT INTO arena_state (singleton, room, state_json, saved_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          room = excluded.room,
          state_json = excluded.state_json,
          saved_at = excluded.saved_at
      `,
      this.state.room,
      serialized,
      now,
    );
  }
}
