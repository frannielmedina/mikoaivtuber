import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";

// ─────────────────────────────────────────────────────────────────────────────
// Talking gestures. While the character is speaking, she makes small
// "explaining" hand movements and nods in time with her voice, on top of the
// idle animation. Like the walk cycle this is layered AFTER the idle controller
// and BEFORE the pose override, so an explicit pose tag ([wave], [shy] …) from
// the AI still wins over these automatic gestures.
// ─────────────────────────────────────────────────────────────────────────────

type Kind = "right" | "left" | "both" | "tilt";

type Gesture = { kind: Kind; t: number; dur: number; amp: number };

const KINDS: Kind[] = ["right", "left", "both", "right", "left", "tilt"];

export class TalkGestureController {
  private _vrm: VRM;
  private _sx: number; // VRM0 mirror sign (same as IdleController)
  private _fwd: number; // "swing forward" sign for rotations about X
  private _activity = 0; // smoothed 0..1: 1 while speaking
  private _vol = 0; // smoothed voice volume
  private _time = 0;
  private _gap = 0.4;
  private _g: Gesture | null = null;

  private _e = new THREE.Euler();
  private _q = new THREE.Quaternion();

  constructor(vrm: VRM) {
    this._vrm = vrm;
    const vrm0 = String((vrm.meta as any)?.metaVersion) === "0";
    this._sx = vrm0 ? -1 : 1;
    this._fwd = vrm0 ? 1 : -1;
  }

  update(delta: number, bodyBlend: number, speaking: boolean, volume: number) {
    this._time += delta;
    this._activity += ((speaking ? 1 : 0) - this._activity) * (1 - Math.exp(-6 * delta));
    this._vol += (Math.min(1, volume * 2.2) - this._vol) * (1 - Math.exp(-14 * delta));
    const a = this._activity * bodyBlend;
    if (a < 0.01) {
      this._g = null;
      this._gap = 0.3;
      return;
    }

    // Start a new gesture every so often while speaking.
    if (!this._g) {
      this._gap -= delta;
      if (this._gap <= 0) {
        this._g = {
          kind: KINDS[Math.floor(Math.random() * KINDS.length)],
          t: 0,
          dur: 0.9 + Math.random() * 0.8,
          amp: 0.7 + Math.random() * 0.5,
        };
      }
    } else {
      this._g.t += delta;
      if (this._g.t >= this._g.dur) {
        this._g = null;
        this._gap = 0.25 + Math.random() * 0.9;
      }
    }

    const h = this._vrm.humanoid;
    if (!h) return;
    const g = this._g;
    const env = g ? Math.pow(Math.sin(Math.PI * (g.t / g.dur)), 2) : 0;
    const beat = Math.sin(this._time * 9) * 0.06 + this._vol * 0.12;

    // Head: gentle nod in time with the voice and a soft tilt.
    const head = h.getNormalizedBoneNode("head" as any);
    if (head) {
      this.pre(head, this._sx * (0.025 + this._vol * 0.09 + (g?.kind === "tilt" ? 0.06 * env : 0)) * a, 0, this._sx * Math.sin(this._time * 0.9) * 0.04 * a + (g?.kind === "tilt" ? 0.1 * env * a * this._sx : 0));
    }

    if (!g || g.kind === "tilt") return;

    // "Explaining" pose: upper arm comes forward, forearm folds up so the hand sits at chest height.
    // (Big enough to read from a front-on camera, where forward motion is foreshortened.)
    const raise = (0.85 * g.amp * env + beat * env) * a; // forward swing of the upper arm
    const flex = (1.25 * g.amp * env + beat * 0.6 * env) * a; // elbow bend

    const arm = (side: "left" | "right") => {
      const upper = h.getNormalizedBoneNode(`${side}UpperArm` as any);
      const lower = h.getNormalizedBoneNode(`${side}LowerArm` as any);
      if (upper) this.pre(upper, this._fwd * raise, 0, 0);
      // Elbow flexes about the forearm's own Y axis: left = -θ, right = +θ (both VRM versions).
      if (lower) this.post(lower, 0, (side === "left" ? -1 : 1) * flex, 0);
    };
    if (g.kind === "right" || g.kind === "both") arm("right");
    if (g.kind === "left" || g.kind === "both") arm("left");
  }

  /** Rotate in the PARENT's frame (premultiply). */
  private pre(node: THREE.Object3D, x: number, y: number, z: number) {
    this._e.set(x, y, z, "XYZ");
    this._q.setFromEuler(this._e);
    node.quaternion.premultiply(this._q);
  }

  /** Rotate in the bone's OWN frame (postmultiply). */
  private post(node: THREE.Object3D, x: number, y: number, z: number) {
    this._e.set(x, y, z, "XYZ");
    this._q.setFromEuler(this._e);
    node.quaternion.multiply(this._q);
  }
}
