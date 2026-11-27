import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";

// ─────────────────────────────────────────────────────────────────────────────
// World-space bone aiming + a two-bone arm solver.
//
// Everything here works in WORLD space (rotate "the line from this bone to its
// child" so it points at a world position), so it does not care whether the model
// is VRM 0.x (mirrored X/Z bone axes) or VRM 1.0, or how the scene is rotated.
// That's what lets hands land on a cat's back, a cup or a table, and lets the
// legs fold onto a chair, without any per-model sign conventions.
// ─────────────────────────────────────────────────────────────────────────────

const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _want = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _d = new THREE.Quaternion();
const _bw = new THREE.Quaternion();
const _pw = new THREE.Quaternion();
const _full = new THREE.Quaternion();
const _base = new THREE.Quaternion();

export function bone(vrm: VRM, name: string): THREE.Object3D | null {
  return vrm.humanoid?.getNormalizedBoneNode(name as any) ?? null;
}

/**
 * Rotate `node` so the line node→child points at `target` (world space).
 * `weight` blends from the bone's rotation at call time (or from `rest` if given,
 * which is needed for bones nothing else resets each frame, like the legs).
 */
export function aimBone(
  node: THREE.Object3D,
  child: THREE.Object3D,
  target: THREE.Vector3,
  weight = 1,
  rest?: THREE.Quaternion
) {
  if (weight <= 0.001) return;
  if (rest) node.quaternion.copy(rest);
  node.updateWorldMatrix(true, true);
  _base.copy(node.quaternion);

  node.getWorldPosition(_p);
  child.getWorldPosition(_c);
  _cur.subVectors(_c, _p);
  _want.subVectors(target, _p);
  if (_cur.lengthSq() < 1e-8 || _want.lengthSq() < 1e-8) return;
  _cur.normalize();
  _want.normalize();

  _d.setFromUnitVectors(_cur, _want);
  node.getWorldQuaternion(_bw);
  _full.copy(_d).multiply(_bw); // new world rotation
  if (node.parent) {
    node.parent.getWorldQuaternion(_pw);
    _full.premultiply(_pw.invert()); // → local
  }
  node.quaternion.slerpQuaternions(_base, _full, Math.min(1, weight));
  node.updateWorldMatrix(false, true);
}

const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _h = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _reach = new THREE.Vector3();

/**
 * Put a hand at `target` (world). `hint` is a world-space direction the elbow
 * should bend toward (e.g. down/back/outward). `weight` 0..1 blends from the
 * current (idle/gesture) arm pose.
 */
export function reachArm(vrm: VRM, side: "left" | "right", target: THREE.Vector3, hint: THREE.Vector3, weight: number) {
  const upper = bone(vrm, `${side}UpperArm`);
  const lower = bone(vrm, `${side}LowerArm`);
  const hand = bone(vrm, `${side}Hand`);
  if (!upper || !lower || !hand || weight <= 0.001) return;

  upper.updateWorldMatrix(true, true);
  upper.getWorldPosition(_s);
  lower.getWorldPosition(_e);
  hand.getWorldPosition(_h);
  const L1 = _s.distanceTo(_e);
  const L2 = _e.distanceTo(_h);
  if (L1 < 1e-4 || L2 < 1e-4) return;

  _dir.subVectors(target, _s);
  const dist = Math.min(Math.max(_dir.length(), 0.05), (L1 + L2) * 0.995);
  _dir.normalize();

  // Law of cosines: distance along the line to the elbow's projection, and its height off the line.
  const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
  const hgt = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
  _pole.copy(hint).addScaledVector(_dir, -hint.dot(_dir));
  if (_pole.lengthSq() < 1e-6) _pole.set(0, -1, 0).addScaledVector(_dir, _dir.y);
  _pole.normalize();
  _elbow.copy(_s).addScaledVector(_dir, a).addScaledVector(_pole, hgt);
  _reach.copy(_s).addScaledVector(_dir, dist);

  aimBone(upper, lower, _elbow, weight);
  aimBone(lower, hand, _reach, weight);
}

const _kn = new THREE.Vector3();
const _ft = new THREE.Vector3();
const _id = new THREE.Quaternion();

/**
 * Fold the legs into a seated pose: thighs point along `forward`, shins hang down.
 * Legs are absolute (nothing else drives them while seated), so this blends from rest.
 */
export function sitLegs(vrm: VRM, forward: THREE.Vector3, amount: number) {
  if (amount <= 0.001) return;
  const fwd = _dir.set(forward.x, 0, forward.z).normalize();
  for (const side of ["left", "right"] as const) {
    const up = bone(vrm, `${side}UpperLeg`);
    const low = bone(vrm, `${side}LowerLeg`);
    const foot = bone(vrm, `${side}Foot`);
    if (!up || !low || !foot) continue;

    up.quaternion.identity();
    low.quaternion.identity();
    foot.quaternion.identity();
    up.updateWorldMatrix(true, true);
    const hip = up.getWorldPosition(new THREE.Vector3());
    const knee0 = low.getWorldPosition(new THREE.Vector3());
    const ankle0 = foot.getWorldPosition(new THREE.Vector3());
    const L1 = hip.distanceTo(knee0);
    const L2 = knee0.distanceTo(ankle0);

    const tilt = 0.1; // thighs slope slightly down toward the knee
    _kn.copy(hip).addScaledVector(fwd, L1 * Math.cos(tilt)).add(_ft.set(0, -L1 * Math.sin(tilt), 0));
    aimBone(up, low, _kn, amount, _id);
    _ft.copy(_kn).add(new THREE.Vector3(0, -L2, 0)).addScaledVector(fwd, 0.04);
    aimBone(low, foot, _ft, amount, _id);
  }
}
