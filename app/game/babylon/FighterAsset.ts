import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AssetContainer, InstantiatedEntries } from "@babylonjs/core/assetContainer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/loaders/glTF";

import type {
  ArenaCombatDirection,
  ArenaPlayer,
} from "../types";

const MODEL_SCALE = 0.64;

function sourceName(name: string): string {
  const separator = name.indexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function attackAnimation(direction: ArenaCombatDirection | undefined): string {
  switch (direction) {
    case "down":
      return "1H_Melee_Attack_Stab";
    case "left":
      return "1H_Melee_Attack_Slice_Diagonal";
    case "right":
      return "1H_Melee_Attack_Slice_Horizontal";
    default:
      return "1H_Melee_Attack_Chop";
  }
}

function paletteColor(color: ArenaPlayer["color"]): Color3 {
  switch (color) {
    case "magenta":
      return Color3.FromHexString("#f063d9");
    case "gold":
      return Color3.FromHexString("#f1c96b");
    case "blue":
      return Color3.FromHexString("#7c91ff");
    default:
      return Color3.FromHexString("#70edff");
  }
}

export class FighterView {
  readonly root: TransformNode;

  private readonly entries: InstantiatedEntries;
  private readonly weaponEntries: InstantiatedEntries;
  private readonly groups = new Map<string, AnimationGroup>();
  private readonly bodyMeshes: Mesh[];
  private readonly weaponMeshes: Mesh[];
  private readonly marker: Mesh;
  private activeAnimation = "";
  private activeCombatKey = "";
  private forcedAnimationUntil = 0;

  constructor(
    id: string,
    playerColor: ArenaPlayer["color"],
    fighterContainer: AssetContainer,
    weaponContainer: AssetContainer,
    scene: Scene,
    shadows: ShadowGenerator,
  ) {
    this.root = new TransformNode(`fighter:${id}`, scene);
    this.entries = fighterContainer.instantiateModelsToScene(
      (name) => `${id}:${name}`,
      false,
      { doNotInstantiate: true },
    );
    for (const node of this.entries.rootNodes) {
      node.parent = this.root;
      if (node instanceof TransformNode) node.scaling.scaleInPlace(MODEL_SCALE);
    }
    const importedBodyMeshes = this.entries.rootNodes
      .flatMap((node) => [node, ...node.getDescendants(false)])
      .filter((node): node is Mesh => node instanceof Mesh);
    const builtInAccessories = new Set(["1H_Wand", "2H_Staff"]);
    this.bodyMeshes = importedBodyMeshes.filter((mesh) => {
      if (!builtInAccessories.has(sourceName(mesh.name))) return true;
      mesh.setEnabled(false);
      return false;
    });
    for (const mesh of this.bodyMeshes) {
      mesh.isPickable = false;
      shadows.addShadowCaster(mesh, true);
    }
    for (const group of this.entries.animationGroups) {
      this.groups.set(sourceName(group.name), group);
    }

    this.weaponEntries = weaponContainer.instantiateModelsToScene(
      (name) => `${id}:weapon:${name}`,
      false,
      { doNotInstantiate: true },
    );
    const allFighterNodes = this.entries.rootNodes.flatMap((node) => [
      node,
      ...node.getDescendants(false),
    ]);
    const handSlot = allFighterNodes.find((node) => sourceName(node.name) === "handslot.r");
    for (const node of this.weaponEntries.rootNodes) {
      node.parent = handSlot ?? this.root;
      if (node instanceof TransformNode) {
        node.position.copyFromFloats(0, 0, 0);
        node.scaling.copyFromFloats(1, 1, 1);
        node.rotationQuaternion = new Quaternion(0, -1, 0, 0);
      }
    }
    this.weaponMeshes = this.weaponEntries.rootNodes
      .flatMap((node) => [node, ...node.getDescendants(false)])
      .filter((node): node is Mesh => node instanceof Mesh);
    for (const mesh of this.weaponMeshes) {
      mesh.isPickable = false;
      shadows.addShadowCaster(mesh, true);
    }

    const markerMaterial = new StandardMaterial(`fighter-marker-material:${id}`, scene);
    const markerColor = paletteColor(playerColor);
    markerMaterial.diffuseColor = markerColor.scale(0.3);
    markerMaterial.emissiveColor = markerColor.scale(0.95);
    markerMaterial.alpha = 0.68;
    markerMaterial.disableLighting = true;
    this.marker = MeshBuilder.CreateTorus(
      `fighter-marker:${id}`,
      { diameter: 1.22, thickness: 0.045, tessellation: 40 },
      scene,
    );
    this.marker.parent = this.root;
    this.marker.position.y = 0.045;
    this.marker.material = markerMaterial;
    this.marker.isPickable = false;
    this.play("Idle", true);
  }

  update(player: ArenaPlayer, now: number, deltaSeconds: number): void {
    const target = new Vector3(player.x, 0, player.y);
    const teleport = Vector3.DistanceSquared(this.root.position, target) > 36;
    const blend = 1 - Math.exp(-Math.max(0.001, deltaSeconds) * 18);
    this.root.position = teleport
      ? target
      : Vector3.Lerp(this.root.position, target, blend);

    const aimLength = Math.hypot(player.aimX, player.aimY);
    if (aimLength > 0.01) {
      const targetYaw = Math.atan2(player.aimX, player.aimY);
      let deltaYaw = targetYaw - this.root.rotation.y;
      deltaYaw = Math.atan2(Math.sin(deltaYaw), Math.cos(deltaYaw));
      this.root.rotation.y += deltaYaw * Math.min(1, blend * 1.35);
    }

    const alive = player.alive !== false;
    this.root.setEnabled(alive || Number(player.respawnAt ?? 0) > now);
    this.marker.visibility = alive ? 0.68 : 0;
    if (!alive) {
      this.playOnce("Death_A", `${player.id}:death:${player.respawnAt ?? 0}`);
      return;
    }

    const combatKey = `${player.combatPhase ?? "idle"}:${player.combatStartedAt ?? 0}:${player.combatDirection ?? "up"}`;
    if (combatKey !== this.activeCombatKey) {
      this.activeCombatKey = combatKey;
      if (player.combatPhase === "releasing") {
        this.playOnce(attackAnimation(player.combatDirection), combatKey, 1.22);
      } else if (player.combatPhase === "stunned") {
        this.playOnce("Hit_A", combatKey, 1.35);
      }
    }

    if (now < this.forcedAnimationUntil) return;
    if (player.combatPhase === "blocking") {
      this.play("Blocking", true);
      return;
    }
    if (player.combatPhase === "drawing") {
      this.play("2H_Melee_Idle", true, 0.72);
      return;
    }
    if (player.combatPhase === "releasing" || player.combatPhase === "stunned") return;

    const speed = Math.hypot(player.vx ?? 0, player.vy ?? 0);
    this.play(speed > 0.35 ? "Running_A" : "Idle", true, speed > 0.35 ? 1.1 : 1);
  }

  playSpell(now: number): void {
    this.forcedAnimationUntil = now + 520;
    this.playOnce("Spellcast_Shoot", `spell:${now}`, 1.35);
  }

  setFirstPersonHidden(hidden: boolean): void {
    for (const mesh of this.bodyMeshes) mesh.visibility = hidden ? 0 : 1;
    for (const mesh of this.weaponMeshes) mesh.visibility = hidden ? 0.92 : 1;
    this.marker.visibility = hidden ? 0 : this.marker.visibility;
  }

  dispose(): void {
    this.entries.dispose();
    this.weaponEntries.dispose();
    this.marker.material?.dispose();
    this.marker.dispose();
    this.root.dispose();
  }

  private play(name: string, loop: boolean, speed = 1): void {
    if (this.activeAnimation === name) return;
    for (const group of this.groups.values()) group.stop();
    const group = this.groups.get(name) ?? this.groups.get("Idle");
    if (!group) return;
    this.activeAnimation = name;
    group.start(loop, speed, group.from, group.to, false);
  }

  private playOnce(name: string, key: string, speed = 1): void {
    if (this.activeAnimation === key) return;
    for (const group of this.groups.values()) group.stop();
    const group = this.groups.get(name);
    if (!group) return;
    this.activeAnimation = key;
    group.start(false, speed, group.from, group.to, false);
  }
}

export class FighterFactory {
  private constructor(
    private readonly fighterContainer: AssetContainer,
    private readonly weaponContainer: AssetContainer,
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator,
  ) {}

  static async load(scene: Scene, shadows: ShadowGenerator): Promise<FighterFactory> {
    const [fighterResult, weaponResult] = await Promise.allSettled([
      SceneLoader.LoadAssetContainerAsync(
        "/assets/arena-v1/fighters/",
        "arcane-mage.glb",
        scene,
      ),
      SceneLoader.LoadAssetContainerAsync(
        "/assets/arena-v1/props/",
        "sword_1handed.gltf",
        scene,
      ),
    ]);

    if (fighterResult.status === "rejected" || weaponResult.status === "rejected") {
      if (fighterResult.status === "fulfilled") fighterResult.value.dispose();
      if (weaponResult.status === "fulfilled") weaponResult.value.dispose();
      throw fighterResult.status === "rejected"
        ? fighterResult.reason
        : weaponResult.reason;
    }

    return new FighterFactory(
      fighterResult.value,
      weaponResult.value,
      scene,
      shadows,
    );
  }

  create(id: string, color: ArenaPlayer["color"]): FighterView {
    return new FighterView(
      id,
      color,
      this.fighterContainer,
      this.weaponContainer,
      this.scene,
      this.shadows,
    );
  }

  dispose(): void {
    this.fighterContainer.dispose();
    this.weaponContainer.dispose();
  }
}
