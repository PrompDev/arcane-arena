import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/?room=ABCDE", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Arcane Arena product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Arcane Arena — Multiplayer spell duels<\/title>/i);
  assert.match(html, /data-product="arcane-arena"/);
  assert.match(html, /Arcane Arena multiplayer spell duel/);
  assert.match(html, /Multiplayer spell duels/);
  assert.match(html, /Display name/);
  assert.match(html, /Enter arena/);
  assert.match(html, /Copy invite/);
  assert.match(html, /Checking graphics/);
  assert.match(html, /WASD/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Codex is working/i);
});

test("ships the real-time client contract without starter imports", async () => {
  const [client, page, layout] = await Promise.all([
    readFile(new URL("../app/game/ArenaGame.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(client, /createArenaRenderer/);
  assert.match(client, /new WebSocket/);
  assert.match(client, /1000 \/ 30/);
  assert.match(client, /type: "input"/);
  assert.match(client, /type: "ping", clientTime/);
  assert.match(client, /message\.type === "welcome"/);
  assert.match(client, /message\.type === "snapshot"/);
  assert.match(client, /message\.type === "pong"/);
  assert.match(client, /navigator\.getGamepads/);
  assert.match(client, /new ArenaAudio/);
  assert.match(client, /contextmenu/);
  assert.match(page, /<ArenaGame \/>/);
  assert.doesNotMatch(page, /_sites-preview|codex-preview|SkeletonPreview/);
  assert.match(layout, /themeColor: "#05070b"/);
});
