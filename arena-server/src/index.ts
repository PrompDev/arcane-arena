export { ArenaRoom } from "./arena-room";

import { MAX_PLAYERS, sanitizeName, sanitizeRoom } from "./protocol";
import { TICK_RATE } from "./game";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function decodedRoom(pathname: string): string | null {
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

function methodNotAllowed(allowed: string): Response {
  return jsonResponse({ error: "Method not allowed" }, 405, { Allow: allowed });
}

function logError(error: unknown, request: Request): void {
  console.error(
    JSON.stringify({
      message: "request failed",
      method: request.method,
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Max-Age": "86400",
            },
          });
        }
        if (request.method !== "GET") {
          return methodNotAllowed("GET, OPTIONS");
        }
        return jsonResponse({
          ok: true,
          service: "arcane-arena-server",
          serverTime: Date.now(),
          tickRate: TICK_RATE,
          maxPlayers: MAX_PLAYERS,
        });
      }

      if (url.pathname.startsWith("/room/")) {
        if (request.method !== "GET") {
          return methodNotAllowed("GET");
        }

        const room = decodedRoom(url.pathname);
        if (room === null) {
          return jsonResponse({ error: "Invalid room" }, 400);
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return jsonResponse(
            { error: "WebSocket upgrade required" },
            426,
            { Upgrade: "websocket" },
          );
        }

        url.pathname = `/room/${encodeURIComponent(room)}`;
        url.searchParams.set("name", sanitizeName(url.searchParams.get("name")));
        const forwardedRequest = new Request(url.toString(), request);
        const roomObject = env.ARENA_ROOMS.getByName(room);
        return await roomObject.fetch(forwardedRequest);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      logError(error, request);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
