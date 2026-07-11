import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseConnectionAttachment,
  sanitizeName,
  sanitizeRoom,
} from "../src/protocol";

describe("protocol validation", () => {
  it("bounds movement, aim, sequence, and action values", () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: "input",
        seq: 22.9,
        moveX: -20,
        moveY: 20,
        aimX: 9,
        aimY: 12,
        dash: true,
        primary: "yes",
        secondary: 1,
        utility: false,
      }),
    );

    expect(message).toEqual({
      type: "input",
      seq: 22,
      moveX: -1 / Math.sqrt(2),
      moveY: 1 / Math.sqrt(2),
      aimX: 0.6,
      aimY: 0.8,
      dash: true,
      primary: false,
      secondary: false,
      utility: false,
    });
  });

  it("rejects malformed and oversized frames", () => {
    expect(parseClientMessage("not-json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "input", seq: "1" }))).toBeNull();
    expect(parseClientMessage("x".repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
    expect(parseClientMessage("🪄".repeat(600))).toBeNull();
  });

  it("sanitizes public room, name, and attachment values", () => {
    expect(sanitizeRoom("arena_01-A")).toBe("arena_01-A");
    expect(sanitizeRoom("../arena")).toBeNull();
    expect(sanitizeName("  Mage\u0000   One  ")).toBe("Mage One");
    expect(sanitizeName("\u0000")).toBe("Mage");
    expect(
      parseConnectionAttachment({
        version: 1,
        playerId: "player-1",
        room: "arena",
        name: "  Test  Mage ",
        joinedAt: 100,
        lastSeq: 4,
      }),
    ).toEqual({
      version: 1,
      playerId: "player-1",
      room: "arena",
      name: "Test Mage",
      joinedAt: 100,
      lastSeq: 4,
    });
  });
});
