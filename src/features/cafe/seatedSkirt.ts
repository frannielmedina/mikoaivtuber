import * as THREE from "three";
import { VRM, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere } from "@pixiv/three-vrm";

// ─────────────────────────────────────────────────────────────────────────────
// Seated skirt physics fix.
//
// The bug: Miko's skirt spring bones are parented to the thigh bones, have
// gravityPower = 0, and only collide with a few thigh spheres that stop ~6 cm
// short of the knee. That is fine while standing, but when the legs are folded
// forward for sitting (ik.ts → sitLegs) the skirt roots swing with the thighs:
// the front chains get thrown UP (a flap standing 15–20 cm above the lap), the
// back chains swing forward UNDER the thighs, and the hem sinks into the knees.
//
// The fix (only while sitting, blended with the sit amount, restored on stand):
//   • extend the thigh colliders down to the knee so the hem can't sink in;
//   • give the skirt real gravity, softer stiffness and a little hit radius so
//     it drapes over the thighs instead of snapping back to the "standing" shape;
//   • steer gravity per chain: front → forward over the lap, back → behind her,
//     sides → straight down.
// Models without "skirt" spring bones (or without thigh colliders) are untouched.
// ─────────────────────────────────────────────────────────────────────────────

const SEATED = {
  stiffness: 0.12,
  gravityPower: 1.6,
  hitRadius: 0.012,
  dragForce: 0.15,
  frontDown: 0.3, // front gravity tilts this much downward (relative to "forward" = 1)
  backBack: 0.8, // back gravity pushes this much backward (relative to "down" = 1)
};

type Kind = "front" | "back" | "side";

export class SeatedSkirt {
  private _joints: any[] = [];
  private _kind: Kind[] = [];
  private _base: { s: number; g: number; h: number; d: number; dir: THREE.Vector3 }[] = [];
  private _extras: { shape: VRMSpringBoneColliderShapeSphere; y: number }[] = [];
  private _dirty = false;
  private _tmp = new THREE.Vector3();

  constructor(vrm: VRM) {
    const mgr: any = (vrm as any).springBoneManager;
    if (!mgr?.joints) return;

    mgr.joints.forEach((j: any) => {
      const name: string = j.bone?.name ?? "";
      if (!/skirt/i.test(name)) return;
      this._joints.push(j);
      this._kind.push(/front/i.test(name) ? "front" : /back/i.test(name) ? "back" : "side");
      this._base.push({
        s: j.settings.stiffness,
        g: j.settings.gravityPower,
        h: j.settings.hitRadius,
        d: j.settings.dragForce,
        dir: j.settings.gravityDir.clone(),
      });
    });

    // Extend each thigh collider group down toward the knee (scaled to the model's own thigh length).
    const seen = new Set<any>();
    for (const j of this._joints) {
      for (const grp of j.colliderGroups ?? []) {
        if (seen.has(grp)) continue;
        seen.add(grp);
        const ref: THREE.Object3D | undefined = grp.colliders.find(
          (c: THREE.Object3D) => c.parent && /upperleg/i.test(c.parent.name)
        );
        const leg = ref?.parent;
        if (!leg) continue;
        const lower = leg.children.find((c) => /lowerleg/i.test(c.name));
        const L = lower ? lower.position.length() : 0.35;
        for (const k of [0.77, 0.94]) {
          const shape = new VRMSpringBoneColliderShapeSphere({
            offset: new THREE.Vector3(0, -L * k, 0),
            radius: L * 0.2,
          });
          const col = new VRMSpringBoneCollider(shape);
          leg.add(col);
          grp.colliders.push(col);
          this._extras.push({ shape, y: -L * k });
        }
      }
    }
    this.apply(0, new THREE.Vector3(0, 0, 1));
  }

  /** sit: 0 standing … 1 seated. forward: world direction her thighs point (y ignored). */
  apply(sit: number, forward: THREE.Vector3) {
    if (!this._joints.length) return;
    if (sit <= 0.001 && !this._dirty) return; // fully standing and already restored
    this._dirty = sit > 0.001;

    const s = Math.min(1, Math.max(0, sit));
    const fx = forward.x, fz = forward.z;
    const n = Math.hypot(fx, fz) || 1;
    const ux = fx / n, uz = fz / n;
    const t = this._tmp;

    for (let i = 0; i < this._joints.length; i++) {
      const j = this._joints[i];
      const b = this._base[i];
      j.settings.stiffness = b.s + (SEATED.stiffness - b.s) * s;
      j.settings.gravityPower = b.g + (SEATED.gravityPower - b.g) * s;
      j.settings.hitRadius = b.h + (SEATED.hitRadius - b.h) * s;
      j.settings.dragForce = b.d + (SEATED.dragForce - b.d) * s;

      const kind = this._kind[i];
      if (kind === "front") t.set(ux, -SEATED.frontDown, uz);
      else if (kind === "back") t.set(-ux * SEATED.backBack, -1, -uz * SEATED.backBack);
      else t.copy(b.dir);
      t.normalize();
      j.settings.gravityDir.copy(b.dir).lerp(t, s).normalize();
    }

    // knee-side colliders only exist while sitting (so standing physics is exactly as before)
    for (const e of this._extras) e.shape.offset.y = s > 0.02 ? e.y : 50;
  }
}
