import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { ArenaRoom } from "../src/arena-room";
import { isRecord } from "../src/protocol";

const openSockets = new Set<WebSocket>();

class SocketInbox {
  private readonly messages: unknown[] = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(event.data);
        this.messages.push(parsed);
      } catch {
        // Tests only consume the server's JSON protocol.
      }
    });
    socket.accept();
    openSockets.add(socket);
  }

  async waitFor(
    predicate: (message: unknown) => boolean,
    timeoutMs = 1_500,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        const [message] = this.messages.splice(index, 1);
        return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for WebSocket message");
  }
}

function hasType(type: string): (message: unknown) => boolean {
  return (message) => isRecord(message) && message.type === type;
}

async function openRoom(room: string, name: string): Promise<SocketInbox> {
  const response = await exports.default.fetch(
    new Request(`https://arena.test/room/${room}?name=${encodeURIComponent(name)}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  if (response.webSocket === null) {
    throw new Error("Expected a WebSocket response");
  }
  return new SocketInbox(response.webSocket);
}

function waitForClose(socket: WebSocket, timeoutMs = 1_500): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket close")), timeoutMs);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

afterEach(async () => {
  for (const socket of openSockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "test complete");
    }
  }
  openSockets.clear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await abortAllDurableObjects();
  await reset();
});

describe("Worker and ArenaRoom integration", () => {
  it("serves health and rejects invalid room requests before invoking a room", async () => {
    const health = await exports.default.fetch(new Request("https://arena.test/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "arcane-arena-server",
      tickRate: 30,
      maxPlayers: 4,
    });

    const noUpgrade = await exports.default.fetch(
      new Request("https://arena.test/room/test?name=Mage"),
    );
    expect(noUpgrade.status).toBe(426);

    const invalid = await exports.default.fetch(
      new Request("https://arena.test/room/not%2Fa%2Froom", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("welcomes a player, persists the SQLite schema, pongs, and streams movement", async () => {
    const inbox = await openRoom("runtime-test", "  Quick   Mage ");
    const welcome = await inbox.waitFor(hasType("welcome"));
    expect(welcome).toMatchObject({
      type: "welcome",
      room: "runtime-test",
      arena: {
        width: 24,
        height: 14,
        tickRate: 30,
        respawnMs: 1_700,
      },
    });
    if (!isRecord(welcome) || typeof welcome.id !== "string") {
      throw new Error("Welcome did not include an id");
    }

    const initial = await inbox.waitFor(hasType("snapshot"));
    if (!isRecord(initial) || !Array.isArray(initial.players)) {
      throw new Error("Initial snapshot was malformed");
    }
    const initialPlayer = initial.players.find(
      (candidate) => isRecord(candidate) && candidate.id === welcome.id,
    );
    if (!isRecord(initialPlayer) || typeof initialPlayer.x !== "number") {
      throw new Error("Initial player was missing");
    }
    const initialX = initialPlayer.x;

    inbox.socket.send(JSON.stringify({ type: "ping", clientTime: 1234 }));
    await expect(inbox.waitFor(hasType("pong"))).resolves.toMatchObject({
      type: "pong",
      clientTime: 1234,
    });

    inbox.socket.send(
      JSON.stringify({
        type: "input",
        seq: 1,
        moveX: 1,
        moveY: 0,
        aimX: 1,
        aimY: 0,
        dash: false,
        primary: false,
        secondary: false,
        utility: false,
      }),
    );
    const moved = await inbox.waitFor((message) => {
      if (!isRecord(message) || message.type !== "snapshot" || !Array.isArray(message.players)) {
        return false;
      }
      return message.players.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === welcome.id &&
          typeof candidate.x === "number" &&
          candidate.x > initialX,
      );
    });
    expect(moved).toBeDefined();

    const stub = env.ARENA_ROOMS.getByName("runtime-test");
    await runInDurableObject(stub, async (instance: ArenaRoom, state) => {
      expect(instance).toBeInstanceOf(ArenaRoom);
      const schema = state.storage.sql
        .exec<{ version: number }>(
          "SELECT MAX(id) AS version FROM _sql_schema_migrations",
        )
        .one();
      const saved = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM arena_state")
        .one();
      expect(schema.version).toBe(1);
      expect(saved.count).toBe(1);
    });
  });

  it("shares one authoritative player state across two live sockets", async () => {
    const alpha = await openRoom("shared-state", "Alpha");
    const beta = await openRoom("shared-state", "Beta");
    const [alphaWelcome, betaWelcome] = await Promise.all([
      alpha.waitFor(hasType("welcome")),
      beta.waitFor(hasType("welcome")),
    ]);

    if (
      !isRecord(alphaWelcome) ||
      typeof alphaWelcome.id !== "string" ||
      !isRecord(betaWelcome) ||
      typeof betaWelcome.id !== "string"
    ) {
      throw new Error("Both sockets must receive distinct player identities");
    }
    expect(alphaWelcome.id).not.toBe(betaWelcome.id);

    const seesBothPlayers = (message: unknown): boolean =>
      isRecord(message) &&
      message.type === "snapshot" &&
      Array.isArray(message.players) &&
      message.players.some(
        (candidate) => isRecord(candidate) && candidate.id === alphaWelcome.id,
      ) &&
      message.players.some(
        (candidate) => isRecord(candidate) && candidate.id === betaWelcome.id,
      );

    const [alphaShared, betaShared] = await Promise.all([
      alpha.waitFor(seesBothPlayers),
      beta.waitFor(seesBothPlayers),
    ]);
    if (
      !isRecord(alphaShared) ||
      !Array.isArray(alphaShared.players) ||
      !isRecord(betaShared) ||
      !Array.isArray(betaShared.players)
    ) {
      throw new Error("Both sockets must receive the shared room snapshot");
    }

    const initialAlpha = alphaShared.players.find(
      (candidate) => isRecord(candidate) && candidate.id === alphaWelcome.id,
    );
    if (!isRecord(initialAlpha) || typeof initialAlpha.x !== "number") {
      throw new Error("Alpha was missing from the shared snapshot");
    }
    const initialX = initialAlpha.x;

    alpha.socket.send(
      JSON.stringify({
        type: "input",
        seq: 1,
        moveX: 1,
        moveY: 0,
        aimX: 1,
        aimY: 0,
        dash: false,
        primary: false,
        secondary: false,
        utility: false,
      }),
    );

    const seesAlphaMove = (message: unknown): boolean => {
      if (!isRecord(message) || message.type !== "snapshot" || !Array.isArray(message.players)) {
        return false;
      }
      return message.players.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === alphaWelcome.id &&
          typeof candidate.x === "number" &&
          candidate.x > initialX + 0.05,
      );
    };

    await expect(
      Promise.all([alpha.waitFor(seesAlphaMove), beta.waitFor(seesAlphaMove)]),
    ).resolves.toHaveLength(2);
  });

  it("expires held movement while keeping the live socket ready for fresh input", async () => {
    const inbox = await openRoom("input-freshness", "Runner");
    const welcome = await inbox.waitFor(hasType("welcome"));
    if (!isRecord(welcome) || typeof welcome.id !== "string") {
      throw new Error("Welcome did not include an id");
    }

    const initial = await inbox.waitFor(hasType("snapshot"));
    if (!isRecord(initial) || !Array.isArray(initial.players)) {
      throw new Error("Initial snapshot was malformed");
    }
    const initialPlayer = initial.players.find(
      (candidate) => isRecord(candidate) && candidate.id === welcome.id,
    );
    if (!isRecord(initialPlayer) || typeof initialPlayer.x !== "number") {
      throw new Error("Initial player was missing");
    }
    const initialX = initialPlayer.x;

    inbox.socket.send(
      JSON.stringify({
        type: "input",
        seq: 1,
        moveX: 1,
        moveY: 0,
        aimX: 1,
        aimY: 0,
        dash: false,
        primary: false,
        secondary: false,
        utility: false,
      }),
    );

    const moving = await inbox.waitFor((message) => {
      if (!isRecord(message) || message.type !== "snapshot" || !Array.isArray(message.players)) {
        return false;
      }
      return message.players.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === welcome.id &&
          typeof candidate.x === "number" &&
          typeof candidate.vx === "number" &&
          candidate.x > initialX + 0.05 &&
          candidate.vx > 0,
      );
    });
    if (!isRecord(moving) || !Array.isArray(moving.players)) {
      throw new Error("Moving snapshot was malformed");
    }
    const movingPlayer = moving.players.find(
      (candidate) => isRecord(candidate) && candidate.id === welcome.id,
    );
    if (!isRecord(movingPlayer) || typeof movingPlayer.x !== "number") {
      throw new Error("Moving player was missing");
    }
    const movingX = movingPlayer.x;

    const settled = await inbox.waitFor((message) => {
      if (!isRecord(message) || message.type !== "snapshot" || !Array.isArray(message.players)) {
        return false;
      }
      return message.players.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === welcome.id &&
          typeof candidate.x === "number" &&
          typeof candidate.vx === "number" &&
          candidate.x > movingX &&
          Math.abs(candidate.vx) < 0.001,
      );
    }, 2_500);
    if (
      !isRecord(settled) ||
      typeof settled.tick !== "number" ||
      !Array.isArray(settled.players)
    ) {
      throw new Error("Settled snapshot was malformed");
    }
    const settledPlayer = settled.players.find(
      (candidate) => isRecord(candidate) && candidate.id === welcome.id,
    );
    if (!isRecord(settledPlayer) || typeof settledPlayer.x !== "number") {
      throw new Error("Settled player was missing");
    }
    const settledTick = settled.tick;
    const settledX = settledPlayer.x;

    await expect(
      inbox.waitFor((message) => {
        if (
          !isRecord(message) ||
          message.type !== "snapshot" ||
          typeof message.tick !== "number" ||
          message.tick < settledTick + 2 ||
          !Array.isArray(message.players)
        ) {
          return false;
        }
        return message.players.some(
          (candidate) =>
            isRecord(candidate) &&
            candidate.id === welcome.id &&
            typeof candidate.x === "number" &&
            Math.abs(candidate.x - settledX) < 0.001,
        );
      }),
    ).resolves.toBeDefined();

    inbox.socket.send(JSON.stringify({ type: "ping", clientTime: 777 }));
    await expect(inbox.waitFor(hasType("pong"))).resolves.toMatchObject({
      type: "pong",
      clientTime: 777,
    });

    inbox.socket.send(
      JSON.stringify({
        type: "input",
        seq: 2,
        moveX: -1,
        moveY: 0,
        aimX: -1,
        aimY: 0,
        dash: false,
        primary: false,
        secondary: false,
        utility: false,
      }),
    );
    await expect(
      inbox.waitFor((message) => {
        if (!isRecord(message) || message.type !== "snapshot" || !Array.isArray(message.players)) {
          return false;
        }
        return message.players.some(
          (candidate) =>
            isRecord(candidate) &&
            candidate.id === welcome.id &&
            typeof candidate.x === "number" &&
            candidate.x < settledX - 0.05,
        );
      }),
    ).resolves.toBeDefined();
  });

  it("enforces the four-player room capacity", async () => {
    const sockets = await Promise.all([
      openRoom("full-room", "One"),
      openRoom("full-room", "Two"),
      openRoom("full-room", "Three"),
      openRoom("full-room", "Four"),
    ]);
    await Promise.all(sockets.map((inbox) => inbox.waitFor(hasType("welcome"))));

    const response = await exports.default.fetch(
      new Request("https://arena.test/room/full-room?name=Five", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Room is full",
      maxPlayers: 4,
    });
  });

  it("closes oversized and abusive connections", async () => {
    const oversized = await openRoom("guard-room-large", "Large");
    await oversized.waitFor(hasType("welcome"));
    const oversizedClose = waitForClose(oversized.socket);
    oversized.socket.send("x".repeat(2_049));
    await expect(oversizedClose).resolves.toMatchObject({ code: 1009 });

    const abusive = await openRoom("guard-room-rate", "Rapid");
    await abusive.waitFor(hasType("welcome"));
    const rateClose = waitForClose(abusive.socket);
    for (let index = 0; index < 121; index += 1) {
      abusive.socket.send(JSON.stringify({ type: "ping", clientTime: index }));
    }
    await expect(rateClose).resolves.toMatchObject({ code: 1008 });
  });
});
