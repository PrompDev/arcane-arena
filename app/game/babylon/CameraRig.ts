import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type {
  ArenaCameraMode,
  ArenaControlBasis,
  ArenaPoint,
} from "../types";

const THIRD_PERSON_DISTANCE = 5.2;
const LOOK_SENSITIVITY = 0.0023;

export class CameraRig {
  readonly camera: FreeCamera;

  private mode: ArenaCameraMode = "third-person";
  private yaw = Math.PI / 2;
  private pitch = -0.12;
  private initialized = false;

  constructor(scene: Scene) {
    this.camera = new FreeCamera("arena-camera", new Vector3(12, 4, -4), scene);
    this.camera.minZ = 0.04;
    this.camera.maxZ = 120;
    this.camera.fov = 0.92;
    this.camera.inertia = 0;
    scene.activeCamera = this.camera;
  }

  addLookDelta(deltaX: number, deltaY: number): void {
    this.yaw += deltaX * LOOK_SENSITIVITY;
    this.pitch = Math.max(-0.52, Math.min(0.32, this.pitch - deltaY * LOOK_SENSITIVITY));
  }

  orientTo(direction: ArenaPoint): void {
    if (this.initialized || Math.hypot(direction.x, direction.y) < 0.01) return;
    this.yaw = Math.atan2(direction.x, direction.y);
    this.initialized = true;
  }

  nudgeIdle(deltaSeconds: number): void {
    if (!this.initialized) this.yaw += deltaSeconds * 0.085;
  }

  setMode(mode: ArenaCameraMode): void {
    this.mode = mode;
  }

  getMode(): ArenaCameraMode {
    return this.mode;
  }

  getBasis(): ArenaControlBasis {
    const forward = { x: Math.sin(this.yaw), y: Math.cos(this.yaw) };
    const right = { x: Math.cos(this.yaw), y: -Math.sin(this.yaw) };
    return { forward, right, aim: forward };
  }

  update(focus: Vector3, deltaSeconds: number): void {
    const basis = this.getBasis();
    const forward = new Vector3(basis.forward.x, 0, basis.forward.y);
    const right = new Vector3(basis.right.x, 0, basis.right.y);
    const lookHeight = Math.sin(this.pitch) * 5.5;

    let desired: Vector3;
    let target: Vector3;
    if (this.mode === "first-person") {
      desired = focus.add(new Vector3(0, 2.2, 0)).add(forward.scale(0.13));
      target = desired.add(forward.scale(10)).add(new Vector3(0, lookHeight, 0));
      this.camera.fov = 1.02;
    } else {
      desired = focus
        .add(new Vector3(0, 2.45 - Math.sin(this.pitch) * 1.05, 0))
        .subtract(forward.scale(THIRD_PERSON_DISTANCE))
        .add(right.scale(0.58));
      target = focus
        .add(new Vector3(0, 1.35, 0))
        .add(forward.scale(1.5))
        .add(new Vector3(0, lookHeight * 0.44, 0));
      this.camera.fov = 0.92;
    }

    const smoothing = 1 - Math.exp(-Math.max(0.001, deltaSeconds) * 13);
    this.camera.position = Vector3.Lerp(this.camera.position, desired, smoothing);
    this.camera.setTarget(Vector3.Lerp(this.camera.getTarget(), target, smoothing));
  }
}
