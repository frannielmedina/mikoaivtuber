import * as THREE from "three";
import { mergeBufferGeometries } from "three/examples/jsm/utils/BufferGeometryUtils";
import { at, box, canvasTexture, cyl, glowSprite, inkMaterial, radialTexture, toon } from "./toon";
import type { Connect4Session } from "../games/gameManager";
import { COLS, ROWS } from "../games/connect4";

// ─────────────────────────────────────────────────────────────────────────────
// Interactive props: cups & tray, the projector screen rig and the 3D Connect 4 board.
// ─────────────────────────────────────────────────────────────────────────────

/** Bake the static meshes of a (not yet placed) group into one mesh per material. */
export function bakeGroup(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const done: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as any).isInstancedMesh || m.userData.keep) return;
    const mat = m.material;
    if (Array.isArray(mat) || mat.transparent) return;
    if (!(mat === inkMaterial || (mat instanceof THREE.MeshToonMaterial && !mat.map))) return;
    const g = m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    for (const n of Object.keys(g.attributes)) if (n !== "position" && n !== "normal" && n !== "uv") g.deleteAttribute(n);
    if (!g.index) return;
    (buckets.get(mat) ?? buckets.set(mat, []).get(mat)!).push(g);
    done.push(m);
  });
  done.forEach((m) => m.parent?.remove(m));
  buckets.forEach((geos, mat) => {
    const geo = mergeBufferGeometries(geos, false);
    if (geo) group.add(new THREE.Mesh(geo, mat));
    geos.forEach((g) => g.dispose());
  });
  return group;
}

export function makeCup(color = 0xfff6ec): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(0.085, 0.085, 0.012, 0xfff6ec, 16), 0, 0.006, 0));
  g.add(at(cyl(0.05, 0.04, 0.07, color, 14, { ink: 0.006 }), 0, 0.047, 0));
  g.add(at(cyl(0.044, 0.044, 0.008, 0x6b4030, 14), 0, 0.083, 0)); // coffee surface
  g.add(at(box(0.03, 0.02, 0.012, color), 0.06, 0.05, 0));
  return bakeGroup(g);
}

/** Serving tray with a cup on it. `cup` can be hidden once the cup has been placed. */
export class Tray {
  readonly group = new THREE.Group();
  readonly cup: THREE.Group;
  private steam: THREE.Sprite;
  private t = 0;

  constructor() {
    const tray = new THREE.Group();
    tray.add(at(cyl(0.19, 0.19, 0.018, 0xff9bb3, 24, { ink: 0.008 }), 0, 0.009, 0));
    tray.add(at(cyl(0.17, 0.17, 0.006, 0xffe3ea, 24), 0, 0.02, 0));
    bakeGroup(tray);
    this.group.add(tray);
    this.cup = makeCup(0xa8e0d0);
    this.cup.position.set(0.02, 0.022, 0);
    this.group.add(this.cup);
    this.steam = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: radialTexture("rgba(255,255,255,0.9)", "rgba(255,255,255,0)"), transparent: true, depthWrite: false, opacity: 0.4 })
    );
    this.steam.scale.set(0.08, 0.08, 1);
    this.group.add(this.steam);
    this.group.visible = false;
  }

  update(dt: number) {
    this.t += dt;
    const u = (this.t * 0.5) % 1;
    this.steam.visible = this.cup.visible;
    this.steam.position.set(0.02, 0.15 + u * 0.18, 0);
    (this.steam.material as THREE.SpriteMaterial).opacity = Math.sin(u * Math.PI) * 0.45;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projector rig: a pull-down screen hung in front of the left window, a ceiling
// projector with a faint light beam. The screen rolls down only while there is
// something to show (see ProjectorStore); the real video/stream is a DOM overlay
// mapped onto the four corners returned by `corners()`.
// ─────────────────────────────────────────────────────────────────────────────
export const SCREEN = { cx: -2.5, top: 3.05, w: 2.4, h: 1.35, z: -3.27 };

export class ProjectorRig {
  readonly group = new THREE.Group();
  private roll = 0;
  private rollTarget = 0;
  private lit = false;
  private shade: THREE.Group; // everything that scales with the roll
  private surface: THREE.Mesh;
  private beam: THREE.Mesh;
  private lens: THREE.Sprite;
  private beamMat: THREE.MeshBasicMaterial;

  constructor() {
    const { cx, top, w, h, z } = SCREEN;

    // roller housing
    const housing = cyl(0.055, 0.055, w + 0.24, 0xf0e8de, 14, { ink: 0.008 });
    housing.rotation.z = Math.PI / 2;
    housing.position.set(cx, top + 0.03, z);
    this.group.add(housing);
    for (const s of [-1, 1]) this.group.add(at(box(0.03, 0.18, 0.03, 0x3a2630), cx + s * (w / 2 + 0.08), top + 0.1, z));

    // canvas that rolls down: anchored at its top edge
    this.shade = new THREE.Group();
    this.shade.position.set(cx, top, z);
    const border = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.12, h + 0.12), new THREE.MeshBasicMaterial({ color: 0x2c2230 }));
    border.position.set(0, -h / 2, -0.004);
    const tex = canvasTexture(512, 288, (ctx, cw, ch) => {
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(1, "#e9e4ee");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = "rgba(81,64,98,0.35)";
      ctx.font = "bold 30px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("type !so for a clip", cw / 2, ch / 2 + 10);
    });
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    this.surface.position.set(0, -h / 2, 0);
    this.shade.add(border, this.surface);
    this.shade.scale.y = 0.001;
    this.group.add(this.shade);

    // ceiling projector
    const proj = new THREE.Group();
    proj.add(at(box(0.5, 0.18, 0.38, 0xf5f0ea, { ink: 0.01 }), 0, 0, 0));
    proj.add(at(cyl(0.07, 0.07, 0.06, 0x2c2230, 16), 0, 0, -0.22).rotateX(Math.PI / 2));
    proj.add(at(cyl(0.01, 0.01, 0.35, 0x3a2630, 6), 0, 0.26, 0.05));
    bakeGroup(proj);
    proj.position.set(cx, 3.9, 1.0);
    this.group.add(proj);
    this.lens = glowSprite("rgba(190,225,255,0.95)", 0.45, 0);
    this.lens.position.set(cx, 3.9, 0.76);
    this.group.add(this.lens);

    // light beam: apex at the lens, base = the four screen corners
    const apex = new THREE.Vector3(cx, 3.9, 0.76);
    const c = this.corners();
    const pos = new Float32Array([
      ...apex.toArray(), ...c[0].toArray(), ...c[1].toArray(),
      ...apex.toArray(), ...c[1].toArray(), ...c[2].toArray(),
      ...apex.toArray(), ...c[2].toArray(), ...c[3].toArray(),
      ...apex.toArray(), ...c[3].toArray(), ...c[0].toArray(),
    ]);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xcfe6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(bg, this.beamMat);
    this.beam.renderOrder = 10;
    this.beam.frustumCulled = false;
    this.group.add(this.beam);

    this.group.visible = false;
  }

  /** Screen corners in world space: TL, TR, BR, BL. */
  corners(): THREE.Vector3[] {
    const { cx, top, w, h, z } = SCREEN;
    return [
      new THREE.Vector3(cx - w / 2, top, z),
      new THREE.Vector3(cx + w / 2, top, z),
      new THREE.Vector3(cx + w / 2, top - h, z),
      new THREE.Vector3(cx - w / 2, top - h, z),
    ];
  }

  setAvailable(on: boolean) {
    this.rollTarget = on ? 1 : 0;
    if (on) this.group.visible = true;
  }
  setLit(on: boolean) {
    this.lit = on;
  }
  /** True once the screen is fully down and the overlay can be shown. */
  get isDown() {
    return this.roll > 0.985;
  }
  get isVisible() {
    return this.group.visible;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    const d = this.rollTarget - this.roll;
    this.roll += Math.sign(d) * Math.min(Math.abs(d), dt * 0.9);
    const e = this.roll * this.roll * (3 - 2 * this.roll);
    this.shade.scale.y = Math.max(0.001, e);
    const lit = this.lit && this.isDown;
    this.beamMat.opacity += ((lit ? 0.055 : 0) - this.beamMat.opacity) * Math.min(1, dt * 4);
    (this.lens.material as THREE.SpriteMaterial).opacity += ((lit ? 0.9 : 0.1) - (this.lens.material as THREE.SpriteMaterial).opacity) * Math.min(1, dt * 4);
    if (this.roll <= 0 && this.rollTarget === 0) this.group.visible = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D Connect 4 board that stands on the table while a game is running.
// ─────────────────────────────────────────────────────────────────────────────
const P = 0.1; // cell pitch (m)
const HOLE = 0.043;
const CHAT = 0xff617f;
const MIKO = 0xffd66b;
export const BOARD_TOP_Y = 0.775;

export class Connect4Board3D {
  readonly group = new THREE.Group();
  private discs: THREE.InstancedMesh;
  private cells: number[] = new Array(ROWS * COLS).fill(0);
  private fall = new Map<number, number>(); // index → seconds since drop
  private winCells = new Set<number>();
  private lastMoves = -1;
  private appear = 0;
  private appearTarget = 0;
  private t = 0;
  private readonly cy = 0.06 + (ROWS * P + 0.1) / 2; // board centre height above the table
  private m4 = new THREE.Matrix4();
  private col = new THREE.Color();

  constructor() {
    const W = COLS * P + 0.1;
    const H = ROWS * P + 0.1;
    const shape = new THREE.Shape();
    const r = 0.05;
    shape.moveTo(-W / 2 + r, -H / 2);
    shape.lineTo(W / 2 - r, -H / 2);
    shape.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + r);
    shape.lineTo(W / 2, H / 2 - r);
    shape.quadraticCurveTo(W / 2, H / 2, W / 2 - r, H / 2);
    shape.lineTo(-W / 2 + r, H / 2);
    shape.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - r);
    shape.lineTo(-W / 2, -H / 2 + r);
    shape.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + r, -H / 2);
    for (let rr = 0; rr < ROWS; rr++) {
      for (let c = 0; c < COLS; c++) {
        const hole = new THREE.Path();
        hole.absarc((c - (COLS - 1) / 2) * P, ((ROWS - 1) / 2 - rr) * P, HOLE, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }
    const frameGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false, curveSegments: 14 });
    frameGeo.translate(0, 0, -0.025);
    const frame = new THREE.Mesh(frameGeo, toon(0x5e4272, 0.0));
    frame.position.y = this.cy;
    this.group.add(frame);

    const back = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, H - 0.02, 0.008), new THREE.MeshBasicMaterial({ color: 0x34253f }));
    back.position.set(0, this.cy, -0.034);
    this.group.add(back);
    for (const s of [-1, 1]) {
      this.group.add(at(box(0.07, 0.06, 0.22, 0x4b3659, { ink: 0.008, glow: 0 }), s * (W / 2 - 0.08), 0.03, 0));
    }

    const geo = new THREE.CylinderGeometry(0.039, 0.039, 0.03, 22).rotateX(Math.PI / 2);
    // unlit so the disc colours stay exact under the cafe lighting
    this.discs = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), ROWS * COLS);
    this.discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.discs.frustumCulled = false;
    this.group.add(this.discs);
    this.hideAll();

    this.group.scale.setScalar(0.001);
    this.group.visible = false;
  }

  private slot(i: number) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    return { x: (col - (COLS - 1) / 2) * P, y: this.cy + ((ROWS - 1) / 2 - row) * P };
  }

  private hideAll() {
    this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < ROWS * COLS; i++) this.discs.setMatrixAt(i, this.m4);
    this.discs.instanceMatrix.needsUpdate = true;
  }

  setVisible(v: boolean) {
    this.appearTarget = v ? 1 : 0;
    if (v) this.group.visible = true;
  }
  get isShown() {
    return this.appearTarget === 1;
  }

  /** Mirror the game state onto the board (new discs drop in; a fresh game clears it). */
  setSession(s: Connect4Session | null) {
    if (!s) {
      this.lastMoves = -1;
      return;
    }
    if (s.moves < this.lastMoves || s.moves === 0) {
      this.cells.fill(0);
      this.fall.clear();
      this.hideAll();
    }
    this.winCells = new Set((s.winLine ?? []).map(([r, c]) => r * COLS + c));
    const lastIdx = s.lastMove ? s.lastMove.row * COLS + s.lastMove.col : -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const v = s.board[r][c];
        if (v === this.cells[i]) continue;
        this.cells[i] = v;
        this.col.setHex(v === 1 ? CHAT : MIKO).convertSRGBToLinear(); // r149 does not colour-manage setHex
        this.discs.setColorAt(i, this.col);
        if (i === lastIdx && s.moves !== this.lastMoves) this.fall.set(i, 0);
        else this.place(i, 0);
      }
    }
    if (this.discs.instanceColor) this.discs.instanceColor.needsUpdate = true;
    this.lastMoves = s.moves;
  }

  private place(i: number, yOffset: number, scale = 1) {
    const { x, y } = this.slot(i);
    this.m4.makeScale(scale, scale, scale).setPosition(x, y + yOffset, 0);
    this.discs.setMatrixAt(i, this.m4);
    this.discs.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    // pop in / out with a little overshoot
    this.appear += Math.sign(this.appearTarget - this.appear) * Math.min(Math.abs(this.appearTarget - this.appear), dt * 2.2);
    const a = this.appear;
    const s = a >= 1 ? 1 : a <= 0 ? 0.001 : 1 + 2.4 * Math.pow(a - 1, 3) + 1.4 * Math.pow(a - 1, 2);
    this.group.scale.setScalar(Math.max(0.001, a * s));
    if (a <= 0 && this.appearTarget === 0) {
      this.group.visible = false;
      return;
    }

    this.fall.forEach((age, i) => {
      const t = age + dt;
      const dur = 0.55;
      if (t >= dur) {
        this.fall.delete(i);
        this.place(i, 0);
        return;
      }
      this.fall.set(i, t);
      const u = t / dur;
      const drop = (ROWS + 1) * P * (1 - Math.min(1, u / 0.7) ** 2); // fall…
      const bounce = u > 0.7 ? Math.sin(((u - 0.7) / 0.3) * Math.PI) * 0.018 : 0; // …small bounce
      this.place(i, drop + bounce);
    });
    this.winCells.forEach((i) => {
      if (!this.fall.has(i)) this.place(i, 0, 1 + 0.14 * Math.sin(this.t * 8));
    });
  }

  /** World position above column `col` (for the hand that drops Miko's disc). */
  columnTop(col: number, out: THREE.Vector3) {
    const x = (col - (COLS - 1) / 2) * P;
    return out.set(x, this.cy + ((ROWS - 1) / 2 + 1) * P + 0.04, 0.03).applyMatrix4(this.group.matrixWorld);
  }
}

/** Little floating hearts for petting the cat. */
export class Hearts {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  private t = 0;
  active = false;

  constructor() {
    const tex = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = "#ff6f91";
      ctx.beginPath();
      ctx.moveTo(w / 2, h * 0.85);
      ctx.bezierCurveTo(w * 0.05, h * 0.55, w * 0.1, h * 0.12, w / 2, h * 0.32);
      ctx.bezierCurveTo(w * 0.9, h * 0.12, w * 0.95, h * 0.55, w / 2, h * 0.85);
      ctx.fill();
    });
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.scale.set(0.09, 0.09, 1);
      s.renderOrder = 11;
      this.sprites.push(s);
      this.group.add(s);
    }
  }

  update(dt: number) {
    this.t += dt;
    this.sprites.forEach((s, i) => {
      const m = s.material as THREE.SpriteMaterial;
      const u = (this.t * 0.45 + i / this.sprites.length) % 1;
      s.position.set(Math.sin(u * 6 + i * 2) * 0.07, u * 0.34, 0.02 * i);
      const target = this.active ? Math.sin(u * Math.PI) * 0.95 : 0;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 6);
      const sc = 0.06 + 0.05 * Math.sin(u * Math.PI);
      s.scale.set(sc, sc, 1);
    });
  }
}

