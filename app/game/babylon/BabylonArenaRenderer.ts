import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RegisterFileTools } from "@babylonjs/core/Misc/fileTools.pure";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import type {
  ArenaCameraMode,
  ArenaControlBasis,
  ArenaEffect,
  ArenaFrame,
  ArenaRenderer,
  ArenaRendererMode,
} from "../types";
import { CameraRig } from "./CameraRig";
import { FighterFactory, FighterView } from "./FighterAsset";

RegisterFileTools();

interface EffectView {
  readonly mesh: Mesh;
  readonly material: StandardMaterial;
  readonly kind: string;
}

interface DungeonKit {
  readonly floor: AssetContainer;
  readonly barrier: AssetContainer;
  readonly pillar: AssetContainer;
  readonly torch: AssetContainer;
  readonly all: AssetContainer[];
}

function material(
  scene: Scene,
  name: string,
  color: Color3,
  emissive = 0,
  alpha = 1,
): StandardMaterial {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = color;
  result.specularColor = Color3.Black();
  result.emissiveColor = color.scale(emissive);
  result.alpha = alpha;
  if (emissive > 0.45) result.disableLighting = true;
  return result;
}

function instantiate(
  container: AssetContainer,
  name: string,
  scene: Scene,
  shadows: ShadowGenerator,
  position: Vector3,
  rotationY = 0,
  scaling = Vector3.One(),
  castsShadow = true,
): TransformNode {
  const root = new TransformNode(name, scene);
  root.position.copyFrom(position);
  root.rotation.y = rotationY;
  root.scaling.copyFrom(scaling);
  const entries = container.instantiateModelsToScene(
    (source) => `${name}:${source}`,
    false,
    { doNotInstantiate: true },
  );
  for (const node of entries.rootNodes) {
    node.parent = root;
    for (const descendant of [node, ...node.getDescendants(false)]) {
      if (descendant instanceof Mesh) {
        descendant.isPickable = false;
        descendant.receiveShadows = true;
        if (castsShadow) shadows.addShadowCaster(descendant, true);
      }
    }
  }
  return root;
}

async function loadDungeonKit(scene: Scene): Promise<DungeonKit> {
  const root = "/assets/dungeon/";
  const [floor, barrier, pillar, torch] = await Promise.all([
    SceneLoader.LoadAssetContainerAsync(root, "floor_tile_large.gltf.glb", scene),
    SceneLoader.LoadAssetContainerAsync(root, "barrier.gltf.glb", scene),
    SceneLoader.LoadAssetContainerAsync(root, "pillar.gltf.glb", scene),
    SceneLoader.LoadAssetContainerAsync(root, "torch_lit.gltf.glb", scene),
  ]);
  return {
    floor,
    barrier,
    pillar,
    torch,
    all: [floor, barrier, pillar, torch],
  };
}

export class BabylonArenaRenderer implements ArenaRenderer {
  readonly mode: ArenaRendererMode;

  private readonly fighters = new Map<string, FighterView>();
  private readonly projectiles = new Map<string, Mesh>();
  private readonly effects = new Map<string, EffectView>();
  private readonly pillars = new Map<string, TransformNode>();
  private readonly seenSpellEvents = new Set<string>();
  private readonly scene: Scene;
  private readonly cameraRig: CameraRig;
  private readonly cinderMaterial: StandardMaterial;
  private lastRenderAt = performance.now();
  private lobbyFocus = new Vector3(12, 0, 7);

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: AbstractEngine,
    private readonly fighterFactory: FighterFactory,
    private readonly dungeon: DungeonKit,
    private readonly shadows: ShadowGenerator,
    scene: Scene,
  ) {
    this.scene = scene;
    this.mode = engine.isWebGPU ? "webgpu" : "webgl2";
    this.cameraRig = new CameraRig(scene);
    this.cinderMaterial = material(
      scene,
      "cinder-material",
      Color3.FromHexString("#ff6a4c"),
      1,
    );
    this.buildArenaShell();
  }

  static async create(canvas: HTMLCanvasElement): Promise<BabylonArenaRenderer> {
    const forceWebGl = new URLSearchParams(window.location.search).get("renderer") === "webgl2";
    const engine: AbstractEngine = !forceWebGl && (await WebGPUEngine.IsSupportedAsync)
      ? await WebGPUEngine.CreateAsync(canvas, {
          antialias: true,
          adaptToDeviceRatio: false,
          powerPreference: "high-performance",
        })
      : new Engine(
          canvas,
          true,
          { powerPreference: "high-performance" },
          false,
        );
    const desiredPixelRatio = Math.min(1.5, window.devicePixelRatio || 1);
    engine.setHardwareScalingLevel((window.devicePixelRatio || 1) / desiredPixelRatio);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.012, 0.018, 0.035, 1);
    scene.ambientColor = new Color3(0.12, 0.13, 0.2);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.016;
    scene.fogColor = new Color3(0.018, 0.025, 0.06);

    const fill = new HemisphericLight("vault-fill", new Vector3(0.15, 1, -0.2), scene);
    fill.intensity = 0.72;
    fill.diffuse = new Color3(0.38, 0.48, 0.7);
    fill.groundColor = new Color3(0.06, 0.035, 0.09);

    const moon = new DirectionalLight("vault-moon", new Vector3(-0.42, -1, 0.3), scene);
    moon.position = new Vector3(11, 18, -8);
    moon.intensity = 2.1;
    moon.diffuse = new Color3(0.68, 0.82, 1);
    const shadows = new ShadowGenerator(1024, moon);
    shadows.usePercentageCloserFiltering = true;
    shadows.bias = 0.0008;
    shadows.normalBias = 0.035;

    const glow = new GlowLayer("arcane-glow", scene, { blurKernelSize: 24 });
    glow.intensity = 0.72;

    const [fighterFactory, dungeon] = await Promise.all([
      FighterFactory.load(scene, shadows),
      loadDungeonKit(scene),
    ]);
    return new BabylonArenaRenderer(
      canvas,
      engine,
      fighterFactory,
      dungeon,
      shadows,
      scene,
    );
  }

  render(frame: ArenaFrame): void {
    const renderAt = performance.now();
    const deltaSeconds = Math.min(0.05, Math.max(0.001, (renderAt - this.lastRenderAt) / 1000));
    this.lastRenderAt = renderAt;
    this.lobbyFocus = new Vector3(frame.arena.width / 2, 0, frame.arena.height / 2);

    this.updatePillars(frame);
    this.updateFighters(frame, deltaSeconds);
    this.updateProjectiles(frame);
    this.updateEffects(frame);

    const local = frame.players.find((player) => player.id === frame.localId);
    const localView = local ? this.fighters.get(local.id) : undefined;
    if (local) this.cameraRig.orientTo({ x: local.aimX, y: local.aimY });
    if (!localView) this.cameraRig.nudgeIdle(deltaSeconds);
    const focus = localView?.root.position ?? this.lobbyFocus;
    this.cameraRig.update(focus, deltaSeconds);
    for (const [id, fighter] of this.fighters) {
      fighter.setFirstPersonHidden(
        id === frame.localId && this.cameraRig.getMode() === "first-person",
      );
    }
    this.scene.render(false);
  }

  resize(): void {
    this.engine.resize(true);
  }

  addLookDelta(deltaX: number, deltaY: number): void {
    this.cameraRig.addLookDelta(deltaX, deltaY);
  }

  setCameraMode(mode: ArenaCameraMode): void {
    this.cameraRig.setMode(mode);
  }

  getCameraMode(): ArenaCameraMode {
    return this.cameraRig.getMode();
  }

  getControlBasis(): ArenaControlBasis {
    return this.cameraRig.getBasis();
  }

  destroy(): void {
    for (const fighter of this.fighters.values()) fighter.dispose();
    for (const mesh of this.projectiles.values()) mesh.dispose();
    for (const view of this.effects.values()) {
      view.material.dispose();
      view.mesh.dispose();
    }
    for (const pillar of this.pillars.values()) pillar.dispose(false, true);
    this.fighterFactory.dispose();
    for (const container of this.dungeon.all) container.dispose();
    this.cinderMaterial.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private buildArenaShell(): void {
    const underfloor = MeshBuilder.CreateCylinder(
      "floating-vault",
      { height: 0.9, diameter: 35, tessellation: 64 },
      this.scene,
    );
    underfloor.position = new Vector3(12, -0.58, 7);
    underfloor.material = material(
      this.scene,
      "vault-stone",
      Color3.FromHexString("#111526"),
    );
    underfloor.receiveShadows = true;

    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        instantiate(
          this.dungeon.floor,
          `floor-${column}-${row}`,
          this.scene,
          this.shadows,
          new Vector3(2 + column * 4, 0, 1.75 + row * 3.5),
          0,
          new Vector3(1, 1, 0.875),
          false,
        );
      }
    }

    for (let column = 0; column < 6; column += 1) {
      const x = 2 + column * 4;
      const lowBarrier = new Vector3(1, 0.55, 1);
      instantiate(this.dungeon.barrier, `barrier-n-${column}`, this.scene, this.shadows, new Vector3(x, 0.02, 0), 0, lowBarrier);
      instantiate(this.dungeon.barrier, `barrier-s-${column}`, this.scene, this.shadows, new Vector3(x, 0.02, 14), Math.PI, lowBarrier);
    }
    for (let row = 0; row < 4; row += 1) {
      const z = 1.75 + row * 3.5;
      const scale = new Vector3(0.875, 0.55, 1);
      instantiate(this.dungeon.barrier, `barrier-w-${row}`, this.scene, this.shadows, new Vector3(0, 0.02, z), Math.PI / 2, scale);
      instantiate(this.dungeon.barrier, `barrier-e-${row}`, this.scene, this.shadows, new Vector3(24, 0.02, z), -Math.PI / 2, scale);
    }

    const ritualMaterial = material(
      this.scene,
      "ritual-line",
      Color3.FromHexString("#8b6cff"),
      1,
      0.72,
    );
    for (const diameter of [5.8, 8.2]) {
      const ring = MeshBuilder.CreateTorus(
        `ritual-ring-${diameter}`,
        { diameter, thickness: 0.035, tessellation: 96 },
        this.scene,
      );
      ring.position = new Vector3(12, 0.085, 7);
      ring.material = ritualMaterial;
      ring.isPickable = false;
    }

    const torchPositions = [
      new Vector3(1.1, 1.2, 1.1),
      new Vector3(22.9, 1.2, 1.1),
      new Vector3(1.1, 1.2, 12.9),
      new Vector3(22.9, 1.2, 12.9),
    ];
    for (const [index, position] of torchPositions.entries()) {
      instantiate(
        this.dungeon.torch,
        `torch-${index}`,
        this.scene,
        this.shadows,
        position,
        0,
        new Vector3(1.45, 1.45, 1.45),
        false,
      );
      const light = new PointLight(`torch-light-${index}`, position.add(new Vector3(0, 0.8, 0)), this.scene);
      light.diffuse = index % 2 ? new Color3(0.45, 0.75, 1) : new Color3(1, 0.34, 0.24);
      light.intensity = 5;
      light.range = 7;
    }

  }

  private updatePillars(frame: ArenaFrame): void {
    const live = new Set<string>();
    for (const [index, obstacle] of frame.arena.obstacles.entries()) {
      const id = obstacle.id ?? `pillar-${index}`;
      live.add(id);
      let pillar = this.pillars.get(id);
      if (!pillar) {
        const radius = obstacle.radius ?? obstacle.r ?? 0.72;
        pillar = instantiate(
          this.dungeon.pillar,
          `collision-${id}`,
          this.scene,
          this.shadows,
          new Vector3(obstacle.x, 0, obstacle.y),
          0,
          new Vector3(radius / 0.75, 0.82, radius / 0.75),
        );
        this.pillars.set(id, pillar);
      }
      pillar.position.x = obstacle.x;
      pillar.position.z = obstacle.y;
    }
    for (const [id, pillar] of this.pillars) {
      if (!live.has(id)) {
        pillar.dispose(false, true);
        this.pillars.delete(id);
      }
    }
  }

  private updateFighters(frame: ArenaFrame, deltaSeconds: number): void {
    const live = new Set<string>();
    for (const player of frame.players) {
      live.add(player.id);
      let fighter = this.fighters.get(player.id);
      if (!fighter) {
        fighter = this.fighterFactory.create(player.id, player.color);
        fighter.root.position = new Vector3(player.x, 0, player.y);
        this.fighters.set(player.id, fighter);
      }
      fighter.update(player, frame.now, deltaSeconds);
    }
    for (const [id, fighter] of this.fighters) {
      if (!live.has(id)) {
        fighter.dispose();
        this.fighters.delete(id);
      }
    }
  }

  private updateProjectiles(frame: ArenaFrame): void {
    const live = new Set<string>();
    for (const projectile of frame.projectiles) {
      live.add(projectile.id);
      let orb = this.projectiles.get(projectile.id);
      if (!orb) {
        orb = MeshBuilder.CreateIcoSphere(
          `cinder:${projectile.id}`,
          { radius: Math.max(0.12, projectile.radius ?? 0.16), subdivisions: 2 },
          this.scene,
        );
        orb.material = this.cinderMaterial;
        orb.isPickable = false;
        this.projectiles.set(projectile.id, orb);
        if (!this.seenSpellEvents.has(projectile.id)) {
          this.seenSpellEvents.add(projectile.id);
          if (projectile.ownerId) this.fighters.get(projectile.ownerId)?.playSpell(frame.now);
        }
      }
      orb.position.set(projectile.x, 1.05, projectile.y);
      const pulse = 1 + Math.sin(frame.now * 0.025) * 0.16;
      orb.scaling.setAll(pulse);
    }
    for (const [id, orb] of this.projectiles) {
      if (!live.has(id)) {
        orb.dispose();
        this.projectiles.delete(id);
      }
    }
  }

  private updateEffects(frame: ArenaFrame): void {
    const live = new Set<string>();
    for (const [index, effect] of frame.effects.entries()) {
      const id = effect.id ?? `${effect.type ?? effect.kind}-${index}`;
      live.add(id);
      let view = this.effects.get(id);
      if (!view) {
        view = this.createEffect(id, effect);
        this.effects.set(id, view);
        if (!this.seenSpellEvents.has(id)) {
          this.seenSpellEvents.add(id);
          if (effect.ownerId && (effect.type === "tide-ring" || effect.type === "volt-lance")) {
            this.fighters.get(effect.ownerId)?.playSpell(frame.now);
          }
        }
      }
      const start = effect.createdAt ?? frame.now;
      const end = effect.expiresAt ?? start + 300;
      const progress = Math.max(0, Math.min(1, (frame.now - start) / Math.max(1, end - start)));
      view.material.alpha = Math.max(0, 1 - progress);
      if (view.kind === "tide-ring") {
        const radius = (effect.radius ?? 2.45) * (0.16 + progress * 0.84);
        view.mesh.scaling.set(radius, 1, radius);
      } else if (view.kind === "spawn" || view.kind === "death") {
        view.mesh.scaling.setAll(0.35 + progress * 2.2);
      } else if (view.kind === "cinder-impact") {
        view.mesh.scaling.setAll(0.35 + progress * 1.6);
      }
    }
    for (const [id, view] of this.effects) {
      if (!live.has(id)) {
        view.material.dispose();
        view.mesh.dispose();
        this.effects.delete(id);
      }
    }
    if (this.seenSpellEvents.size > 768) this.seenSpellEvents.clear();
  }

  private createEffect(id: string, effect: ArenaEffect): EffectView {
    const kind = effect.type ?? effect.kind;
    let mesh: Mesh;
    let color = Color3.FromHexString("#70edff");
    if (kind === "volt-lance" || kind === "dash") {
      color = kind === "volt-lance"
        ? Color3.FromHexString("#ffe46b")
        : Color3.FromHexString("#9f8cff");
      const end = new Vector3(effect.x2 ?? effect.x, 0.75, effect.y2 ?? effect.y);
      mesh = MeshBuilder.CreateTube(
        `effect:${id}`,
        {
          path: [new Vector3(effect.x, 0.75, effect.y), end],
          radius: kind === "volt-lance" ? 0.08 : 0.045,
          tessellation: 12,
        },
        this.scene,
      );
    } else if (kind === "tide-ring") {
      color = Color3.FromHexString("#52d8ff");
      mesh = MeshBuilder.CreateTorus(
        `effect:${id}`,
        { diameter: 2, thickness: 0.07, tessellation: 72 },
        this.scene,
      );
      mesh.position.set(effect.x, 0.12, effect.y);
    } else if (kind === "spawn" || kind === "death") {
      color = kind === "death"
        ? Color3.FromHexString("#f063d9")
        : Color3.FromHexString("#70edff");
      mesh = MeshBuilder.CreateTorus(
        `effect:${id}`,
        { diameter: 1, thickness: 0.055, tessellation: 56 },
        this.scene,
      );
      mesh.position.set(effect.x, 0.18, effect.y);
    } else {
      color = Color3.FromHexString("#ff6a4c");
      mesh = MeshBuilder.CreateIcoSphere(
        `effect:${id}`,
        { radius: 0.3, subdivisions: 2 },
        this.scene,
      );
      mesh.position.set(effect.x, 0.75, effect.y);
    }
    const effectMaterial = material(this.scene, `effect-material:${id}`, color, 1, 1);
    mesh.material = effectMaterial;
    mesh.isPickable = false;
    return { mesh, material: effectMaterial, kind };
  }
}
