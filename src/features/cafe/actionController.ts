import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";
import { bone, reachArm, sitLegs } from "./ik";
import { SeatedSkirt } from "./seatedSkirt";

// ─────────────────────────────────────────────────────────────────────────────
// BodyActions: the "doing things with real objects" layer — sitting on a chair,
// resting / reaching hands on a table, patting a cat, carrying a tray.
//
// It runs AFTER idle, walk and talk gestures, and BEFORE an explicit AI pose
// override. The CafeDirector tells it every frame what the body should be doing
// (world-space targets); this class only applies it, with smooth fade-in/out.
// ─────────────────────────────────────────────────────────────────────────────

export type ArmGoal = { target: THREE.Vector3; hint: THREE.Vector3 };

export class BodyActions {
  private _vrm: VRM;
  private _skirt: SeatedSkirt; // keeps the skirt spring-bones sane while the legs are folded for sitting
  private _sx: number; // VRM0 mirror sign — only used for the head nod, which is bone-local

  // set by the director
  sit = 0; // 0 standing … 1 seated (already eased by the director)
  sitForward = new THREE.Vector3(0, 0, 1);
  twist = 0; // radians the upper body turns (about the vertical axis) away from the hips
  headPitch = 0; // radians, + = look down
  leanRoll = 0; // radians, sideways lean of the spine
  private _goals: { left: ArmGoal | null; right: ArmGoal | null } = { left: null, right: null };
  private _w = { left: 0, right: 0 };

  private _e = new THREE.Euler();
  private _q = new THREE.Quaternion();

  constructor(vrm: VRM) {
    this._vrm = vrm;
    this._skirt = new SeatedSkirt(vrm);
    this._sx = String((vrm.meta as any)?.metaVersion) === "0" ? -1 : 1;
  }

  /** Aim a hand at a world position (null = let go). Weight fades automatically. */
  setArm(side: "left" | "right", goal: ArmGoal | null) {
    this._goals[side] = goal;
  }

  get active() {
    return this.sit > 0.001 || this._w.left > 0.01 || this._w.right > 0.01;
  }

  update(delta: number, bodyBlend: number) {
    const vrm = this._vrm;
    const k = 1 - Math.exp(-7 * delta);
    for (const s of ["left", "right"] as const) {
      this._w[s] += ((this._goals[s] ? 1 : 0) - this._w[s]) * k;
    }
    const b = bodyBlend;

    if (this.sit > 0.001) sitLegs(vrm, this.sitForward, this.sit * b);
    // Runs every frame (cheap no-op once standing) so the skirt settings fade back when she gets up.
    this._skirt.apply(this.sit * b, this.sitForward);

    // Upper body: turn toward the camera / lean toward something (parent-frame Y/Z rotations)
    if (Math.abs(this.twist) > 0.001 || Math.abs(this.leanRoll) > 0.001) {
      this.pre("spine", 0, this.twist * 0.4 * b, this.leanRoll * 0.5 * b);
      this.pre("chest", 0, this.twist * 0.4 * b, this.leanRoll * 0.5 * b);
      this.pre("head", 0, this.twist * 0.2 * b, 0);
    }
    if (Math.abs(this.headPitch) > 0.001) this.pre("head", this._sx * this.headPitch * b, 0, 0);

    for (const s of ["left", "right"] as const) {
      const g = this._goals[s];
      const w = this._w[s] * b;
      if (w > 0.01 && g) reachArm(vrm, s, g.target, g.hint, w);
    }
  }

  private pre(name: string, x: number, y: number, z: number) {
    const n = bone(this._vrm, name);
    if (!n) return;
    this._e.set(x, y, z, "XYZ");
    this._q.setFromEuler(this._e);
    n.quaternion.premultiply(this._q);
  }
}
