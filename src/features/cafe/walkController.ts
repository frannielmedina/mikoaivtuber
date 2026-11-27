import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";

// ─────────────────────────────────────────────────────────────────────────────
// Procedural walk cycle. The repo has no walking animation file, so the legs,
// hips and arm swing are generated from sine waves and layered on TOP of the
// existing procedural idle (IdleController): idle runs first, then this adds
// the stride. It fades in/out with walking speed, so stopping is smooth.
//
// Bone-axis convention (same as IdleController): normalized VRM 0.x bones have
// their X/Z axes mirrored vs VRM 1.0 (after VRMUtils.rotateVRM0), so every
// "swing forward" rotation about X is multiplied by FWD (+1 for VRM0, -1 for VRM1).
// If a model ever walks backwards, flip WALK_SIGN below.
// ─────────────────────────────────────────────────────────────────────────────

export const WALK_SIGN = 1; // set to -1 to reverse the leg/arm swing direction

const STRIDE_M = 1.25; // metres covered per full gait cycle (two steps)
const THIGH_SWING = 0.46; // rad
const KNEE_FLEX = 0.78; // rad, peak during the swing phase
const KNEE_REST = 0.05;
const ARM_SWING = 0.32; // rad
const BOB = 0.012; // metres of up/down body bounce
const HIP_TWIST = 0.07;

export class WalkController {
  private _vrm: VRM;
  private _fwd: number; // sign for "forward" rotation about the X axis
  private _phase = 0;
  private _blend = 0;
  private _speed = 0; // metres per second, set by the director every frame
  private _active = false;
  /** Vertical body bounce in metres — the CafeDirector adds it to the character's height. */
  bob = 0;

  private _qa = new THREE.Quaternion();
  private _qb = new THREE.Quaternion();
  private _e = new THREE.Euler();
  private _id = new THREE.Quaternion();

  constructor(vrm: VRM) {
    this._vrm = vrm;
    const vrm0 = String((vrm.meta as any)?.metaVersion) === "0";
    this._fwd = (vrm0 ? 1 : -1) * WALK_SIGN;
  }

  /** Current ground speed in m/s (0 = standing still). */
  setSpeed(mps: number) {
    this._speed = Math.max(0, mps);
  }

  /** 0..1 how much of the walk cycle is currently applied. */
  get blend() {
    return this._blend;
  }

  update(delta: number, bodyBlend: number) {
    const target = Math.min(1, this._speed / 0.3) * bodyBlend;
    this._blend += (target - this._blend) * (1 - Math.exp(-9 * delta));

    if (this._blend < 0.003) {
      if (this._active) this.reset();
      return;
    }
    this._active = true;

    this._phase += (this._speed / STRIDE_M) * Math.PI * 2 * delta;
    const p = this._phase;
    const b = this._blend;
    const h = this._vrm.humanoid;
    if (!h) return;

    const F = this._fwd;
    const s = Math.sin(p);
    const c = Math.cos(p);

    // Left leg uses phase p, right leg p + π.
    const leg = (side: "left" | "right", sin: number, cos: number) => {
      const thigh = THIGH_SWING * sin; // forward angle
      const knee = KNEE_REST + KNEE_FLEX * Math.max(0, cos); // flexes while the leg swings through
      this.setLegX(h.getNormalizedBoneNode(`${side}UpperLeg` as any), F * thigh, b);
      this.setLegX(h.getNormalizedBoneNode(`${side}LowerLeg` as any), F * -knee, b);
      // Keep the foot roughly level with the floor.
      this.setLegX(h.getNormalizedBoneNode(`${side}Foot` as any), F * -(thigh - knee) * 0.55, b);
    };
    leg("left", s, c);
    leg("right", -s, -c);

    // Arms swing opposite to the same-side leg. Premultiply = rotate about the
    // parent's lateral axis, which is a forward/back swing for a hanging arm.
    this.swing(h.getNormalizedBoneNode("leftUpperArm" as any), F * -ARM_SWING * s * b);
    this.swing(h.getNormalizedBoneNode("rightUpperArm" as any), F * ARM_SWING * s * b);

    // Hips twist a little with each step, shoulders counter-twist.
    const hips = h.getNormalizedBoneNode("hips" as any);
    if (hips) {
      this._e.set(0, HIP_TWIST * s, 0.025 * c, "XYZ");
      this._qa.setFromEuler(this._e);
      hips.quaternion.slerpQuaternions(this._id, this._qa, b);
    }
    const spine = h.getNormalizedBoneNode("spine" as any);
    if (spine) {
      this._e.set(0, -HIP_TWIST * 0.8 * s * b, 0, "XYZ");
      this._qb.setFromEuler(this._e);
      spine.quaternion.premultiply(this._qb);
    }

    // The body is lowest when the legs are furthest apart.
    this.bob = BOB * Math.cos(2 * p) * b;
  }

  /** Legs are not touched by the idle, so they are set absolutely (rest pose → stride, by `blend`). */
  private setLegX(node: THREE.Object3D | null, angle: number, blend: number) {
    if (!node) return;
    this._e.set(angle, 0, 0, "XYZ");
    this._qa.setFromEuler(this._e);
    node.quaternion.slerpQuaternions(this._id, this._qa, blend);
  }

  private swing(node: THREE.Object3D | null, angle: number) {
    if (!node) return;
    this._e.set(angle, 0, 0, "XYZ");
    this._qb.setFromEuler(this._e);
    node.quaternion.premultiply(this._qb);
  }

  /** Snap legs/hips back to the rest pose once the walk has fully faded out. */
  private reset() {
    this._active = false;
    const h = this._vrm.humanoid;
    if (!h) return;
    for (const name of [
      "leftUpperLeg", "leftLowerLeg", "leftFoot",
      "rightUpperLeg", "rightLowerLeg", "rightFoot", "hips",
    ]) {
      h.getNormalizedBoneNode(name as any)?.quaternion.identity();
    }
    this.bob = 0;
  }
}
