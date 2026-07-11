import type { ArenaRenderer } from "./types";

/**
 * Babylon is loaded only in the browser so the lobby can still server-render
 * without evaluating WebGPU or WebGL globals.
 */
export async function createArenaRenderer(
  canvas: HTMLCanvasElement,
): Promise<ArenaRenderer> {
  const { BabylonArenaRenderer } = await import(
    "./babylon/BabylonArenaRenderer"
  );
  return BabylonArenaRenderer.create(canvas);
}
