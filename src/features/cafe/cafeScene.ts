import * as THREE from "three";
import { mergeBufferGeometries } from "three/examples/jsm/utils/BufferGeometryUtils";
import {
  at,
  blobShadow,
  box,
  canvasTexture,
  cone,
  cyl,
  glowSprite,
  INK,
  inkMaterial,
  mulberry,
  radialTexture,
  sphere,
  toon,
  toonGradient,
} from "./toon";
import { TimeOfDay } from "./cafeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// The anime cafe. A single room seen from its open front:
//
//            back wall: window · window · counter & menu board
//     left wall: bookshelf                     right wall: pictures, OPEN sign
//
//   x: left(-) → right(+)    y: up    z: back(-) → toward the camera(+)
//
// Everything is cel-shaded (MeshToonMaterial + ink outlines), flat-coloured and
// built from primitives, so there are no model/texture files to download.
// ─────────────────────────────────────────────────────────────────────────────

export const ROOM = { x0: -4.8, x1: 4.8, z0: -3.6, z1: 4.6, h: 4.2 };

export type Waypoint = { x: number; z: number };
export type Obstacle = { x: number; z: number; r: number };

type Tod = {
  skyTop: string;
  skyBottom: string;
  ambient: number; // tint multiplied into the scene's ambient light
  dir: number; // tint multiplied into the scene's directional light
  lamp: number; // 0..1 how lit the lamps / windows' warm glow are
  shaft: number; // light-shaft opacity
  shaftColor: string;
  /** Screen-space colour grade (multiplied over the frame); null = none. */
  grade: number | null;
};

const TOD: Record<TimeOfDay, Tod> = {
  day: { skyTop: "#7cc8ff", skyBottom: "#e6f6ff", ambient: 0xffffff, dir: 0xffffff, lamp: 0.0, shaft: 0.22, shaftColor: "#fff2c0", grade: null },
  sunset: { skyTop: "#ff8f9c", skyBottom: "#ffd9a0", ambient: 0xffdcc0, dir: 0xffb98a, lamp: 0.55, shaft: 0.34, shaftColor: "#ffaa66", grade: 0xffd3b4 },
  night: { skyTop: "#161a45", skyBottom: "#4b4488", ambient: 0x8f9ce0, dir: 0xaab4ff, lamp: 1.0, shaft: 0.12, shaftColor: "#b8ccff", grade: 0x4b569c },
};

const C = {
  wall: 0xf1d3bf,
  wainscot: 0xd89f90,
  rail: 0xf3e3d3,
  wood: 0xb9835a,
  woodDark: 0x8c5b3d,
  woodLight: 0xd9a876,
  cream: 0xf5e8da,
  pink: 0xff9bb3,
  pinkSoft: 0xffc8d6,
  mint: 0xa8e0d0,
  butter: 0xffe08a,
  leaf: 0x7ec98f,
  leafDark: 0x4fa56d,
  terracotta: 0xe08f6e,
};

export class CafeScene {
  readonly group = new THREE.Group();
  readonly waypoints: Waypoint[] = [
    { x: 0.0, z: 0.9 },
    { x: -1.5, z: 0.3 },
    { x: 1.4, z: 0.5 },
    { x: 0.2, z: -1.5 },
    { x: 2.6, z: -1.4 },
    { x: -1.0, z: -0.9 },
    { x: 2.3, z: 1.0 },
    { x: -2.0, z: 1.1 },
    { x: 1.6, z: -0.2 },
  ];
  readonly obstacles: Obstacle[] = [];
  /**
   * Where the character may walk. The wide-shot camera frames her full body only up to
   * roughly z = 1.4, so the walkable area stops there (the floor in front is foreground).
   */
  readonly bounds = { minX: -3.9, maxX: 3.9, minZ: -2.2, maxZ: 1.4 };
  /** Fake contact shadow that follows the character. */
  readonly modelShadow: THREE.Mesh;
  /** Where the camera looks in the wide shot / where the room's "centre of interest" is. */
  readonly center = new THREE.Vector3(0, 1.6, -0.6);

  private _tod: TimeOfDay = "day";
  private _time = 0;

  private _skyTex?: THREE.CanvasTexture;
  private _skyMat!: THREE.MeshBasicMaterial;
  private _stars!: THREE.Points;
  private _petals!: THREE.Points;
  private _petalData!: { vy: number; ph: number; sp: number }[];
  private _shafts: THREE.Mesh[] = [];
  private _glows: THREE.Sprite[] = [];
  private _neon!: THREE.MeshBasicMaterial;
  private _bulbMats: THREE.MeshBasicMaterial[] = [];
  private _lights: THREE.PointLight[] = [];
  private _hourHand!: THREE.Group;
  private _minHand!: THREE.Group;
  private _secHand!: THREE.Group;
  private _cat!: THREE.Group;
  private _steam: { sprite: THREE.Sprite; base: THREE.Vector3; ph: number }[] = [];
  private _windowGlow!: THREE.MeshBasicMaterial[];
  private _grade!: THREE.Mesh;

  constructor() {
    this.group.name = "CafeScene";
    this.buildShell();
    this.buildWindows();
    this.buildOutside();
    this.buildCounter();
    this.buildFurniture();
    this.buildDecor();
    this.buildLighting();

    this.modelShadow = blobShadow(0.36, 0.3, 0.4);
    this.group.add(this.modelShadow);

    // Colour grade for sunset/night: a camera-facing quad that MULTIPLIES the picture.
    // Glows and light shafts have a higher renderOrder, so lamps stay bright on top of it.
    this._grade = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        premultipliedAlpha: true,
        blending: THREE.MultiplyBlending,
        depthTest: false,
        depthWrite: false,
      })
    );
    this._grade.renderOrder = 5;
    this._grade.frustumCulled = false;
    this.group.add(this._grade);

    this.mergeStatics();
    this.setTimeOfDay("day");
  }

  /**
   * Performance: the cafe is ~500 small meshes, but they share a handful of cached toon
   * materials. Bake every static one into one mesh per material (≈ 10× fewer draw calls).
   * Anything animated is flagged `userData.dynamic` and left alone.
   */
  private mergeStatics() {
    this.group.updateMatrixWorld(true);
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const merged: THREE.Mesh[] = [];

    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as any).isInstancedMesh) return;
      const mat = m.material;
      if (Array.isArray(mat) || mat.transparent) return;
      const mergeable = mat === inkMaterial || (mat instanceof THREE.MeshToonMaterial && !mat.map);
      if (!mergeable) return;
      for (let p: THREE.Object3D | null = m; p && p !== this.group; p = p.parent) {
        if (p.userData.dynamic) return;
      }
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
      }
      if (!g.index) return; // all primitives used here are indexed
      (buckets.get(mat) ?? buckets.set(mat, []).get(mat)!).push(g);
      merged.push(m);
    });

    merged.forEach((m) => m.parent?.remove(m));
    buckets.forEach((geos, mat) => {
      const geo = mergeBufferGeometries(geos, false);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "cafe-static";
      this.group.add(mesh);
      geos.forEach((g) => g.dispose());
    });
  }

  get tint() {
    const t = TOD[this._tod];
    return { ambient: t.ambient, dir: t.dir };
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  // ── Time of day ────────────────────────────────────────────────────────────
  setTimeOfDay(tod: TimeOfDay) {
    this._tod = tod;
    const t = TOD[tod];
    this.paintSky(tod);
    this._stars.visible = tod === "night";
    this._shafts.forEach((s) => {
      const m = s.material as THREE.MeshBasicMaterial;
      m.color.set(t.shaftColor);
      m.opacity = t.shaft;
    });
    this._glows.forEach((g) => ((g.material as THREE.SpriteMaterial).opacity = 0.08 + t.lamp * 0.5));
    this._lights.forEach((l) => (l.intensity = t.lamp * 0.9));
    this._neon.color.set(tod === "day" ? 0xffb3c6 : 0xff6f9c);
    this._grade.visible = t.grade !== null;
    if (t.grade !== null) (this._grade.material as THREE.MeshBasicMaterial).color.setHex(t.grade);
    this._windowGlow.forEach((m) => m.color.set(tod === "night" ? 0xffe9a8 : 0xfff6dc));
    (this._petals.material as THREE.PointsMaterial).color.set(tod === "night" ? 0xc9c3ff : 0xffffff);
  }

  /** Keeps the colour-grade quad glued in front of the camera. */
  updateGrade(camera: THREE.PerspectiveCamera) {
    if (!this._grade.visible) return;
    const d = 0.5;
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
    this._grade.position.copy(camera.position).add(new THREE.Vector3(0, 0, -d).applyQuaternion(camera.quaternion));
    this._grade.quaternion.copy(camera.quaternion);
    this._grade.scale.set(h * camera.aspect, h, 1);
  }

  // ── Per-frame animation ────────────────────────────────────────────────────
  update(dt: number) {
    this._time += dt;
    const t = this._time;

    // Falling sakura petals outside the windows
    const pos = this._petals.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this._petalData.length; i++) {
      const d = this._petalData[i];
      let y = pos.getY(i) - d.vy * dt;
      let x = pos.getX(i) + Math.sin(t * d.sp + d.ph) * 0.35 * dt + 0.12 * dt;
      if (y < 0.1) {
        y = 5.2;
        x = -7 + Math.random() * 10;
      }
      if (x > 4) x = -7;
      pos.setXYZ(i, x, y, pos.getZ(i));
    }
    pos.needsUpdate = true;

    // String-light twinkle
    this._bulbMats.forEach((m, i) => {
      const k = 0.72 + 0.28 * Math.sin(t * (1.2 + i * 0.35) + i * 1.7);
      m.color.setRGB(1 * k, 0.86 * k, 0.55 * k);
    });

    // Cat breathing
    if (this._cat) {
      const b = 1 + Math.sin(t * 1.6) * 0.03;
      this._cat.scale.set(1, b, 1);
    }

    // Steam
    this._steam.forEach((s, i) => {
      const u = (t * 0.35 + s.ph) % 1;
      s.sprite.position.set(s.base.x + Math.sin(u * 6 + i) * 0.02, s.base.y + u * 0.28, s.base.z);
      (s.sprite.material as THREE.SpriteMaterial).opacity = Math.sin(u * Math.PI) * 0.5;
      const sc = 0.06 + u * 0.1;
      s.sprite.scale.set(sc, sc, 1);
    });

    // Wall clock shows the real local time
    const now = new Date();
    const sec = now.getSeconds() + now.getMilliseconds() / 1000;
    const min = now.getMinutes() + sec / 60;
    const hr = (now.getHours() % 12) + min / 60;
    this._secHand.rotation.z = -(sec / 60) * Math.PI * 2;
    this._minHand.rotation.z = -(min / 60) * Math.PI * 2;
    this._hourHand.rotation.z = -(hr / 12) * Math.PI * 2;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Shell: floor, walls, ceiling, trim
  // ───────────────────────────────────────────────────────────────────────────
  private buildShell() {
    const { x0, x1, z0, z1, h } = ROOM;
    const W = x1 - x0;
    const D = z1 - z0;
    const g = this.group;

    // Floor: warm wood planks
    const planks = canvasTexture(1024, 1024, (ctx, w, hh) => {
      const rnd = mulberry(7);
      const rows = 30;
      const ph = hh / rows;
      const tones = ["#e2b98b", "#d9ad7d", "#e8c297", "#d4a574", "#dfb487"];
      for (let r = 0; r < rows; r++) {
        let x = -rnd() * 200;
        while (x < w) {
          const len = 220 + rnd() * 260;
          ctx.fillStyle = tones[Math.floor(rnd() * tones.length)];
          ctx.fillRect(x, r * ph, len, ph);
          ctx.fillStyle = "rgba(120,70,40,0.55)";
          ctx.fillRect(x, r * ph, 2, ph);
          x += len;
        }
        ctx.fillStyle = "rgba(120,70,40,0.5)";
        ctx.fillRect(0, r * ph, w, 2);
      }
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshToonMaterial({ map: planks, gradientMap: toonGradient(), emissive: new THREE.Color(0x6b4a35) })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, (z0 + z1) / 2);
    g.add(floor);

    // Round rug in the middle of the walking area
    const rugTex = canvasTexture(512, 512, (ctx, w, hh) => {
      const cx = w / 2;
      const cy = hh / 2;
      const rings = [
        ["#ffc2d1", 256],
        ["#fff1f4", 222],
        ["#ff9bb3", 200],
        ["#fff1f4", 170],
        ["#ffc2d1", 150],
        ["#fff9f2", 110],
      ] as const;
      rings.forEach(([c, r]) => {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "#ff9bb3";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * 185, cy + Math.sin(a) * 185, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 48),
      new THREE.MeshBasicMaterial({ map: rugTex, transparent: true })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.scale.set(1, 0.72, 1);
    rug.position.set(0, 0.003, 0.7);
    g.add(rug);

    // Ceiling + wooden beams
    const ceil = box(W, 0.1, D, 0xfff3e6, { glow: 0.5 });
    at(ceil, 0, h + 0.05, (z0 + z1) / 2);
    g.add(ceil);
    for (let z = z0 + 1.0; z < z1; z += 1.7) {
      g.add(at(box(W, 0.22, 0.2, C.woodDark), 0, h - 0.11, z));
    }

    // ── Back wall (real openings for the windows) ──
    const t = 0.25;
    const zc = z0 - t / 2;
    const wall = (xa: number, xb: number, ya: number, yb: number, col: number, zOff = 0) =>
      g.add(at(box(xb - xa, yb - ya, t, col, { glow: 0.3 }), (xa + xb) / 2, (ya + yb) / 2, zc + zOff));

    wall(x0, x1, 0, 1.0, C.wainscot); // wainscot band
    wall(x0, -3.3, 1.0, h, C.wall);
    wall(-1.7, -0.9, 1.0, h, C.wall);
    wall(1.3, x1, 1.0, h, C.wall);
    wall(-3.3, -1.7, 3.4, h, C.wall); // above window 1
    wall(-0.9, 1.3, 3.4, h, C.wall); // above window 2
    g.add(at(box(W, 0.07, 0.07, C.rail), 0, 1.02, z0 + 0.04)); // chair rail
    g.add(at(box(W, 0.13, 0.05, C.rail), 0, 0.065, z0 + 0.03)); // baseboard
    // wainscot panel lines
    for (let x = x0 + 0.5; x < x1; x += 1.0) {
      g.add(at(box(0.04, 0.78, 0.03, 0xd79c8a), x, 0.52, z0 + 0.02));
    }

    // ── Side walls ──
    const sideWall = (x: number, inward: 1 | -1) => {
      const cxw = x - inward * (t / 2); // wall slab sits just outside the room
      const zm = (z0 + z1) / 2;
      g.add(at(box(t, 1.0, D, C.wainscot, { glow: 0.3 }), cxw, 0.5, zm));
      g.add(at(box(t, h - 1.0, D, C.wall, { glow: 0.3 }), cxw, 1.0 + (h - 1.0) / 2, zm));
      g.add(at(box(0.07, 0.07, D, C.rail), x + inward * 0.04, 1.02, zm));
      g.add(at(box(0.05, 0.13, D, C.rail), x + inward * 0.03, 0.065, zm));
    };
    sideWall(x0, 1);
    sideWall(x1, -1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Windows with curtains, light shafts and the painted sky behind
  // ───────────────────────────────────────────────────────────────────────────
  private buildWindows() {
    const g = this.group;
    const z0 = ROOM.z0;
    this._windowGlow = [];

    const mkWindow = (xa: number, xb: number) => {
      const cx = (xa + xb) / 2;
      const w = xb - xa;
      const ya = 1.0;
      const yb = 3.4;
      const cy = (ya + yb) / 2;
      const fr = C.rail;

      // frame
      g.add(at(box(0.09, yb - ya, 0.16, fr), xa + 0.045, cy, z0 + 0.02));
      g.add(at(box(0.09, yb - ya, 0.16, fr), xb - 0.045, cy, z0 + 0.02));
      g.add(at(box(w, 0.09, 0.16, fr), cx, yb - 0.045, z0 + 0.02));
      g.add(at(box(w, 0.09, 0.16, fr), cx, ya + 0.045, z0 + 0.02));
      // mullions
      g.add(at(box(0.05, yb - ya, 0.08, fr), cx, cy, z0 + 0.0));
      g.add(at(box(w, 0.05, 0.08, fr), cx, ya + (yb - ya) * 0.62, z0 + 0.0));
      // sill
      g.add(at(box(w + 0.3, 0.06, 0.32, fr, { ink: 0.012 }), cx, ya - 0.02, z0 + 0.12));

      // sunlit glass tint (very faint)
      const glassMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc, transparent: true, opacity: 0.1, depthWrite: false });
      this._windowGlow.push(glassMat);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, yb - ya - 0.1), glassMat);
      glass.position.set(cx, cy, z0 + 0.03);
      g.add(glass);

      // curtains
      for (const side of [-1, 1]) {
        const cxx = side < 0 ? xa - 0.12 : xb + 0.12;
        const cur = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const fold = box(0.14, 2.75, 0.07, i === 1 ? C.pinkSoft : C.pink);
          fold.position.set((i - 1) * 0.13, 0, 0);
          cur.add(fold);
        }
        cur.position.set(cxx, 2.2, z0 + 0.12);
        g.add(cur);
        g.add(at(box(0.5, 0.05, 0.05, C.butter), cxx, 1.7, z0 + 0.17)); // tie-back
      }
      // curtain rod
      g.add(at(cyl(0.02, 0.02, w + 0.9, C.woodDark, 8), cx, 3.55, z0 + 0.12).rotateZ(Math.PI / 2));

      // slanted light shafts
      for (let i = 0; i < 2; i++) {
        const tex = canvasTexture(64, 256, (ctx, ww, hh) => {
          const gr = ctx.createLinearGradient(0, 0, 0, hh);
          gr.addColorStop(0, "rgba(255,255,255,0.9)");
          gr.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = gr;
          ctx.fillRect(0, 0, ww, hh);
          const gx = ctx.createLinearGradient(0, 0, ww, 0);
          gx.addColorStop(0, "rgba(0,0,0,1)");
          gx.addColorStop(0.5, "rgba(0,0,0,0)");
          gx.addColorStop(1, "rgba(0,0,0,1)");
          ctx.globalCompositeOperation = "destination-out";
          ctx.fillStyle = gx;
          ctx.fillRect(0, 0, ww, hh);
        });
        const shaft = new THREE.Mesh(
          new THREE.PlaneGeometry(0.75 + i * 0.35, 5.6),
          new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          })
        );
        shaft.position.set(cx + (i - 0.5) * 0.9 + 0.6, 1.35, z0 + 1.35);
        shaft.rotation.set(-0.5, 0, 0.18);
        shaft.renderOrder = 10;
        this._shafts.push(shaft);
        g.add(shaft);
      }
    };
    mkWindow(-3.3, -1.7);
    mkWindow(-0.9, 1.3);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // What you see through the windows: painted sky, hills, a sakura tree, petals
  // ───────────────────────────────────────────────────────────────────────────
  private buildOutside() {
    const g = this.group;
    const z0 = ROOM.z0;

    this._skyMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(44, 24), this._skyMat);
    sky.position.set(0, 6, z0 - 14);
    g.add(sky);

    // Stars (night only)
    const sp = new Float32Array(160 * 3);
    const r = mulberry(11);
    for (let i = 0; i < 160; i++) {
      sp[i * 3] = (r() - 0.5) * 40;
      sp[i * 3 + 1] = 4 + r() * 9;
      sp[i * 3 + 2] = z0 - 13.8;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    this._stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.11, sizeAttenuation: true, depthWrite: false }));
    g.add(this._stars);

    // Grass strip + path
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(44, 14), new THREE.MeshBasicMaterial({ color: 0x9fd9a2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.01, z0 - 7.2);
    g.add(ground);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 14), new THREE.MeshBasicMaterial({ color: 0xf2d9b8 }));
    path.rotation.x = -Math.PI / 2;
    path.position.set(0.3, 0.0, z0 - 7.2);
    g.add(path);

    // Sakura tree
    const tree = new THREE.Group();
    const trunk = cyl(0.2, 0.34, 3.4, 0x8a5a44, 10, { ink: 0.03 });
    trunk.position.y = 1.7;
    trunk.rotation.z = 0.06;
    tree.add(trunk);
    const branch = (x: number, y: number, rz: number, len: number) => {
      const b = cyl(0.07, 0.12, len, 0x8a5a44, 8);
      b.position.set(x, y, 0);
      b.rotation.z = rz;
      tree.add(b);
    };
    branch(-0.7, 3.2, 0.9, 1.7);
    branch(0.8, 3.4, -0.8, 1.8);
    branch(0.1, 3.9, 0.2, 1.2);
    const blossomCols = [0xffb7c9, 0xffc9d6, 0xffa6bd, 0xffd6e0];
    const rnd = mulberry(23);
    const spots: [number, number, number, number][] = [
      [-1.5, 4.2, 0.1, 1.3],
      [1.6, 4.3, 0.0, 1.35],
      [0, 5.0, 0.2, 1.4],
      [-0.4, 3.8, 0.9, 1.1],
      [0.9, 3.5, 0.9, 1.0],
      [-2.4, 3.5, -0.3, 0.95],
      [2.4, 3.6, -0.2, 0.95],
      [-1.0, 5.0, -0.3, 1.0],
      [1.2, 5.0, -0.3, 1.0],
    ];
    spots.forEach(([x, y, z, rr], i) => {
      const s = sphere(rr, blossomCols[i % blossomCols.length], { ink: 0.03 }, 14, 10);
      s.position.set(x + (rnd() - 0.5) * 0.2, y, z);
      tree.add(s);
    });
    tree.position.set(-1.7, 0, z0 - 6.2);
    g.add(tree);

    // A second, smaller tree in the distance
    const t2 = tree.clone();
    t2.scale.setScalar(0.62);
    t2.position.set(3.2, 0, z0 - 10);
    g.add(t2);

    // Petals
    const N = 110;
    const pp = new Float32Array(N * 3);
    this._petalData = [];
    const pr = mulberry(5);
    for (let i = 0; i < N; i++) {
      pp[i * 3] = -7 + pr() * 10;
      pp[i * 3 + 1] = pr() * 5.2;
      pp[i * 3 + 2] = z0 - 0.6 - pr() * 6.5;
      this._petalData.push({ vy: 0.18 + pr() * 0.22, ph: pr() * 6.28, sp: 0.8 + pr() * 1.2 });
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pp, 3));
    const petalTex = canvasTexture(32, 32, (ctx, w, h) => {
      ctx.fillStyle = "#ffc2d4";
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w * 0.3, h * 0.45, 0.6, 0, Math.PI * 2);
      ctx.fill();
    });
    this._petals = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ map: petalTex, size: 0.16, transparent: true, depthWrite: false, alphaTest: 0.05 })
    );
    g.add(this._petals);
  }

  private paintSky(tod: TimeOfDay) {
    const t = TOD[tod];
    const tex = canvasTexture(1024, 512, (ctx, w, h) => {
      const gr = ctx.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, t.skyTop);
      gr.addColorStop(0.75, t.skyBottom);
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, w, h);

      const rnd = mulberry(99);
      if (tod === "night") {
        // moon with halo
        const mg = ctx.createRadialGradient(780, 120, 10, 780, 120, 120);
        mg.addColorStop(0, "rgba(255,250,225,0.9)");
        mg.addColorStop(1, "rgba(255,250,225,0)");
        ctx.fillStyle = mg;
        ctx.fillRect(600, 0, 360, 260);
        ctx.fillStyle = "#fffbe8";
        ctx.beginPath();
        ctx.arc(780, 120, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = t.skyTop;
        ctx.beginPath();
        ctx.arc(795, 112, 30, 0, Math.PI * 2);
        ctx.fill();
      } else {
        if (tod === "sunset") {
          const sg = ctx.createRadialGradient(300, 330, 5, 300, 330, 260);
          sg.addColorStop(0, "rgba(255,255,220,1)");
          sg.addColorStop(0.2, "rgba(255,210,150,0.8)");
          sg.addColorStop(1, "rgba(255,180,140,0)");
          ctx.fillStyle = sg;
          ctx.fillRect(0, 100, 700, 400);
        }
        // fluffy clouds
        for (let i = 0; i < 7; i++) {
          const cx = rnd() * w;
          const cy = 60 + rnd() * 170;
          ctx.fillStyle = tod === "sunset" ? "rgba(255,235,225,0.85)" : "rgba(255,255,255,0.92)";
          for (let k = 0; k < 5; k++) {
            ctx.beginPath();
            ctx.ellipse(cx + k * 34 - 70, cy + Math.sin(k * 1.7) * 10, 44 + rnd() * 20, 26 + rnd() * 10, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // distant hills and little houses
      const hill = tod === "night" ? "#2c3a6b" : tod === "sunset" ? "#d98aa0" : "#a9dca9";
      const hill2 = tod === "night" ? "#232d58" : tod === "sunset" ? "#c47690" : "#86c98f";
      ctx.fillStyle = hill;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 32) ctx.lineTo(x, 370 + Math.sin(x * 0.012) * 26 + Math.sin(x * 0.03) * 8);
      ctx.lineTo(w, h);
      ctx.fill();
      ctx.fillStyle = hill2;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 32) ctx.lineTo(x, 420 + Math.sin(x * 0.02 + 1.2) * 20);
      ctx.lineTo(w, h);
      ctx.fill();
      for (let i = 0; i < 9; i++) {
        const hx = 40 + i * 112 + rnd() * 30;
        const hy = 405 + Math.sin(hx * 0.02 + 1.2) * 20;
        ctx.fillStyle = tod === "night" ? "#3a3f78" : "#fff5ea";
        ctx.fillRect(hx, hy - 24, 38, 24);
        ctx.fillStyle = tod === "night" ? "#2a2f60" : "#e8847a";
        ctx.beginPath();
        ctx.moveTo(hx - 5, hy - 24);
        ctx.lineTo(hx + 19, hy - 46);
        ctx.lineTo(hx + 43, hy - 24);
        ctx.fill();
        if (tod === "night") {
          ctx.fillStyle = "#ffe6a0";
          ctx.fillRect(hx + 14, hy - 17, 9, 9);
        }
      }
    });
    this._skyTex?.dispose();
    this._skyTex = tex;
    this._skyMat.map = tex;
    this._skyMat.needsUpdate = true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Counter, espresso machine, cake case, shelves and the menu board
  // ───────────────────────────────────────────────────────────────────────────
  private buildCounter() {
    const g = this.group;
    const z0 = ROOM.z0;
    const cx = 3.0;
    const cz = -2.95;

    const body = box(3.2, 1.0, 0.8, C.woodLight, { ink: 0.02 });
    at(body, cx, 0.5, cz);
    g.add(body);
    for (let i = 0; i < 12; i++) {
      g.add(at(box(0.05, 0.78, 0.03, C.wood), cx - 1.46 + i * 0.265, 0.5, cz + 0.41));
    }
    g.add(at(box(3.3, 0.07, 0.92, C.cream, { ink: 0.015 }), cx, 1.035, cz));

    // espresso machine
    const em = new THREE.Group();
    em.add(at(box(0.72, 0.42, 0.42, C.mint, { ink: 0.015 }), 0, 0.21, 0));
    em.add(at(box(0.76, 0.06, 0.46, 0xfff6ec), 0, 0.45, 0));
    for (const dx of [-0.18, 0.18]) {
      em.add(at(cyl(0.05, 0.05, 0.1, 0xb8c4cc, 10), dx, 0.12, 0.24));
      em.add(at(box(0.12, 0.03, 0.05, 0x3a2630), dx, 0.05, 0.27));
    }
    em.add(at(sphere(0.07, 0xfff6ec, { ink: 0.01 }), 0, 0.53, 0));
    em.position.set(1.9, 1.07, cz - 0.05);
    g.add(em);

    // cups on the machine
    for (let i = 0; i < 3; i++) {
      g.add(at(cyl(0.05, 0.04, 0.07, i % 2 ? C.pinkSoft : 0xfff6ec, 12, { ink: 0.008 }), 1.7 + i * 0.12, 1.57, cz - 0.05));
    }

    // cake display case
    const case_ = new THREE.Group();
    case_.add(at(box(1.15, 0.08, 0.55, C.wood, { ink: 0.015 }), 0, 0.04, 0));
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.5, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.22, depthWrite: false })
    );
    glass.position.y = 0.33;
    case_.add(glass);
    case_.add(at(box(1.15, 0.04, 0.55, C.wood), 0, 0.6, 0));
    case_.add(at(box(1.05, 0.02, 0.45, C.cream), 0, 0.31, 0));
    const cakeCols = [C.pink, C.butter, 0xc9a07a, C.mint];
    for (let i = 0; i < 4; i++) {
      const cake = new THREE.Group();
      cake.add(at(cyl(0.11, 0.11, 0.09, cakeCols[i], 14, { ink: 0.008 }), 0, 0.05, 0));
      cake.add(at(cyl(0.11, 0.11, 0.02, C.cream, 14), 0, 0.1, 0));
      cake.add(at(sphere(0.03, 0xff4f6e, undefined, 8, 6), 0, 0.14, 0));
      cake.position.set(-0.38 + i * 0.25, 0.33, 0);
      case_.add(cake);
    }
    case_.position.set(3.3, 1.07, cz + 0.02);
    g.add(case_);

    // register + tip jar
    g.add(at(box(0.42, 0.26, 0.3, 0xf4efe9, { ink: 0.012 }), 4.15, 1.2, cz - 0.05));
    const scr = box(0.3, 0.16, 0.02, 0x4a6a7a);
    scr.position.set(4.15, 1.34, cz + 0.11);
    scr.rotation.x = -0.4;
    g.add(scr);
    g.add(at(cyl(0.08, 0.08, 0.16, 0xdfe9ee, 14, { ink: 0.008 }), 3.75, 1.14, cz + 0.2));

    // steam above two cups
    this.addSteam(1.7, 1.66, cz - 0.05, 0);
    this.addSteam(1.94, 1.66, cz - 0.05, 0.5);

    // shelves on the wall behind the counter
    const jarCols = [C.pinkSoft, C.mint, C.butter, 0xffd0a8, 0xcfe4ff];
    [1.95, 2.55].forEach((y, row) => {
      g.add(at(box(3.0, 0.06, 0.3, C.wood, { ink: 0.012 }), cx, y, z0 + 0.15));
      const r = mulberry(40 + row);
      for (let i = 0; i < 12; i++) {
        const x = cx - 1.35 + i * 0.245;
        const kind = r();
        if (kind < 0.5) {
          const hh = 0.14 + r() * 0.1;
          g.add(at(cyl(0.065, 0.065, hh, jarCols[i % jarCols.length], 12, { ink: 0.008 }), x, y + 0.03 + hh / 2, z0 + 0.15));
          g.add(at(cyl(0.07, 0.07, 0.025, C.wood, 12), x, y + 0.04 + hh, z0 + 0.15));
        } else if (kind < 0.8) {
          g.add(at(cyl(0.05, 0.04, 0.08, i % 2 ? 0xfff6ec : C.pink, 12, { ink: 0.008 }), x, y + 0.07, z0 + 0.15));
        } else {
          g.add(at(box(0.12, 0.2, 0.08, 0xd9a876, { ink: 0.008 }), x, y + 0.13, z0 + 0.15));
        }
      }
    });

    // menu board
    const board = canvasTexture(1024, 400, (ctx, w, h) => {
      ctx.fillStyle = "#2f4a45";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      for (let i = 0; i < 40; i++) {
        ctx.beginPath();
        ctx.moveTo(Math.random() * w, Math.random() * h);
        ctx.lineTo(Math.random() * w, Math.random() * h);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffe9f0";
      ctx.textAlign = "center";
      ctx.font = "bold 74px Georgia, serif";
      ctx.fillText("Cafe Miko", w / 2, 92);
      ctx.strokeStyle = "#ffb3c6";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(250, 118);
      ctx.lineTo(w - 250, 118);
      ctx.stroke();
      ctx.font = "bold 40px Arial, sans-serif";
      ctx.textAlign = "left";
      const items = [
        ["Strawberry Latte", "480"],
        ["Matcha Cream Soda", "520"],
        ["Fluffy Pancakes", "780"],
        ["Neko Cheesecake", "650"],
      ];
      items.forEach(([n, p], i) => {
        const y = 188 + i * 52;
        ctx.fillStyle = i % 2 ? "#ffe9f0" : "#c8f0e0";
        ctx.fillText(n, 120, y);
        ctx.textAlign = "right";
        ctx.fillText(p, w - 120, y);
        ctx.textAlign = "left";
      });
      // little steaming cup doodle
      ctx.strokeStyle = "#ffe9f0";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(w - 70, 90, 20, 0.1, Math.PI - 0.1);
      ctx.stroke();
    });
    const bd = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.05), new THREE.MeshBasicMaterial({ map: board }));
    bd.position.set(cx, 3.25, z0 + 0.04);
    g.add(bd);
    const bf = box(2.82, 1.17, 0.05, C.wood, { ink: 0.012 });
    bf.position.set(cx, 3.25, z0 + 0.02);
    g.add(bf);

    // blocking circles along the counter front so the character never walks into it
    for (let x = 1.4; x <= 4.6; x += 0.7) this.obstacles.push({ x, z: -2.2, r: 0.5 });
  }

  private addSteam(x: number, y: number, z: number, ph: number) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTexture("rgba(255,255,255,0.9)", "rgba(255,255,255,0)"),
        transparent: true,
        depthWrite: false,
        opacity: 0,
      })
    );
    s.position.set(x, y, z);
    this.group.add(s);
    this._steam.push({ sprite: s, base: new THREE.Vector3(x, y, z), ph });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tables, chairs, window bench + cat, bookshelf, plants
  // ───────────────────────────────────────────────────────────────────────────
  private makeChair(cushion: number): THREE.Group {
    const c = new THREE.Group();
    c.add(at(box(0.46, 0.07, 0.46, C.wood, { ink: 0.014 }), 0, 0.45, 0));
    c.add(at(box(0.4, 0.05, 0.4, cushion), 0, 0.51, 0));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) c.add(at(cyl(0.022, 0.022, 0.43, C.woodDark, 8), sx * 0.19, 0.215, sz * 0.19));
    }
    c.add(at(box(0.46, 0.42, 0.05, C.wood, { ink: 0.014 }), 0, 0.77, -0.21));
    c.add(at(box(0.34, 0.26, 0.03, cushion), 0, 0.79, -0.18));
    return c;
  }

  private makeTable(withCake: boolean): THREE.Group {
    const t = new THREE.Group();
    t.add(at(cyl(0.5, 0.5, 0.05, C.cream, 28, { ink: 0.014 }), 0, 0.75, 0));
    t.add(at(cyl(0.52, 0.52, 0.02, C.pinkSoft, 28), 0, 0.735, 0));
    t.add(at(cyl(0.05, 0.05, 0.7, C.woodDark, 10), 0, 0.37, 0));
    t.add(at(cyl(0.24, 0.26, 0.05, C.woodDark, 20, { ink: 0.012 }), 0, 0.025, 0));
    // bud vase
    t.add(at(cyl(0.035, 0.03, 0.11, 0xcfe4ff, 10, { ink: 0.006 }), 0.12, 0.835, -0.08));
    t.add(at(cyl(0.006, 0.006, 0.12, C.leafDark, 5), 0.12, 0.95, -0.08));
    t.add(at(sphere(0.04, C.pink, { ink: 0.006 }, 10, 8), 0.12, 1.02, -0.08));
    // cup & saucer
    t.add(at(cyl(0.085, 0.085, 0.012, 0xfff6ec, 16), -0.14, 0.782, 0.12));
    t.add(at(cyl(0.05, 0.04, 0.07, C.mint, 14, { ink: 0.006 }), -0.14, 0.82, 0.12));
    if (withCake) {
      t.add(at(cyl(0.1, 0.1, 0.012, 0xfff6ec, 16), 0.1, 0.782, 0.14));
      t.add(at(cyl(0.07, 0.07, 0.06, C.pink, 14, { ink: 0.006 }), 0.1, 0.82, 0.14));
      t.add(at(sphere(0.022, 0xff4f6e, undefined, 8, 6), 0.1, 0.867, 0.14));
    }
    return t;
  }

  private makePlant(scale = 1, big = false): THREE.Group {
    const p = new THREE.Group();
    p.add(at(cyl(0.26, 0.2, 0.38, C.terracotta, 16, { ink: 0.016 }), 0, 0.19, 0));
    p.add(at(cyl(0.27, 0.27, 0.05, 0xf0a98a, 16), 0, 0.4, 0));
    const r = mulberry(big ? 3 : 8);
    const n = big ? 11 : 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r();
      const lean = 0.35 + r() * 0.5;
      const len = (big ? 0.8 : 0.5) + r() * 0.35;
      const leaf = sphere(0.16, i % 2 ? C.leaf : C.leafDark, { ink: 0.012 }, 10, 8);
      leaf.scale.set(1, len / 0.16 / 1.0, 0.45);
      leaf.position.set(Math.cos(a) * lean * 0.3, 0.45 + len * 0.45, Math.sin(a) * lean * 0.3);
      leaf.rotation.set(Math.sin(a) * lean, 0, -Math.cos(a) * lean);
      p.add(leaf);
    }
    p.scale.setScalar(scale);
    return p;
  }

  private buildFurniture() {
    const g = this.group;

    const place = (obj: THREE.Object3D, x: number, z: number, ry = 0) => {
      obj.position.set(x, 0, z);
      obj.rotation.y = ry;
      g.add(obj);
    };

    const shadowAt = (x: number, z: number, rx: number, rz: number, o = 0.3) => {
      const s = blobShadow(rx, rz, o);
      s.position.x = x;
      s.position.z = z;
      g.add(s);
    };

    const setups: { x: number; z: number; chairs: [number, number, number][]; cake: boolean; cush: number }[] = [
      { x: -2.5, z: -2.3, chairs: [[-3.2, -2.3, Math.PI / 2], [-1.8, -2.3, -Math.PI / 2]], cake: true, cush: C.pink },
      { x: -3.4, z: 0.95, chairs: [[-3.4, 0.25, 0], [-3.4, 1.65, Math.PI]], cake: false, cush: C.mint },
      { x: 3.5, z: -0.4, chairs: [[2.8, -0.4, Math.PI / 2], [4.2, -0.4, -Math.PI / 2]], cake: true, cush: C.butter },
    ];
    setups.forEach((s) => {
      place(this.makeTable(s.cake), s.x, s.z);
      this.obstacles.push({ x: s.x, z: s.z, r: 0.78 });
      shadowAt(s.x, s.z, 0.75, 0.7);
      s.chairs.forEach(([cx, cz, ry]) => {
        place(this.makeChair(s.cush), cx, cz, ry);
        this.obstacles.push({ x: cx, z: cz, r: 0.42 });
        shadowAt(cx, cz, 0.32, 0.32, 0.25);
      });
    });

    // Window bench under the centre window, with cushions and a sleepy cat
    const bench = new THREE.Group();
    bench.add(at(box(2.1, 0.4, 0.62, C.woodLight, { ink: 0.018 }), 0, 0.2, 0));
    bench.add(at(box(2.0, 0.1, 0.56, C.pink, { ink: 0.014 }), 0, 0.45, 0));
    const pil1 = box(0.4, 0.34, 0.12, C.butter, { ink: 0.01 });
    pil1.position.set(-0.8, 0.67, -0.2);
    pil1.rotation.set(-0.25, 0, 0.1);
    bench.add(pil1);
    const pil2 = box(0.36, 0.3, 0.12, C.mint, { ink: 0.01 });
    pil2.position.set(0.85, 0.65, -0.2);
    pil2.rotation.set(-0.25, 0, -0.1);
    bench.add(pil2);
    bench.position.set(0.2, 0, -3.28);
    g.add(bench);
    shadowAt(0.2, -3.2, 1.15, 0.5, 0.3);

    this._cat = this.makeCat();
    this._cat.userData.dynamic = true;
    this._cat.position.set(0.25, 0.5, -3.2);
    g.add(this._cat);

    // Bookshelf on the left wall (built facing +z, then turned to face +x)
    const shelf = new THREE.Group();
    const sh = 2.45;
    const sw = 2.5;
    shelf.add(at(box(sw, sh, 0.06, C.woodDark), 0, sh / 2, -0.16));
    shelf.add(at(box(0.07, sh, 0.36, C.wood, { ink: 0.012 }), -sw / 2, sh / 2, 0));
    shelf.add(at(box(0.07, sh, 0.36, C.wood, { ink: 0.012 }), sw / 2, sh / 2, 0));
    const rows = 5;
    const bookGeo = new THREE.BoxGeometry(1, 1, 1);
    const bookCount = 130;
    const books = new THREE.InstancedMesh(bookGeo, toon(0xffffff, 0.3), bookCount);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const col = new THREE.Color();
    const bookCols = [0xff9bb3, 0xa8e0d0, 0xffe08a, 0xcfb3ff, 0xffc08a, 0x9ecbff, 0xf4a6a6, 0xb7e3a0];
    const br = mulberry(77);
    let bi = 0;
    for (let r = 0; r <= rows; r++) {
      const y = r * ((sh - 0.1) / rows) + 0.04;
      shelf.add(at(box(sw, 0.06, 0.36, C.wood, { glow: 0.3 }), 0, y, 0));
      if (r === rows) break;
      let x = -sw / 2 + 0.12;
      while (x < sw / 2 - 0.15 && bi < bookCount) {
        const bw = 0.05 + br() * 0.05;
        const bh = 0.28 + br() * 0.14;
        const lean = br() < 0.08 ? 0.25 : 0;
        e.set(0, 0, lean);
        q.setFromEuler(e);
        m4.compose(new THREE.Vector3(x + bw / 2, y + 0.03 + bh / 2, 0.02), q, new THREE.Vector3(bw, bh, 0.24));
        books.setMatrixAt(bi, m4);
        col.setHex(bookCols[Math.floor(br() * bookCols.length)]);
        books.setColorAt(bi, col);
        bi++;
        x += bw + 0.005 + (lean ? 0.08 : 0);
      }
    }
    books.count = bi;
    books.instanceMatrix.needsUpdate = true;
    if (books.instanceColor) books.instanceColor.needsUpdate = true;
    shelf.add(books);
    shelf.position.set(-4.6, 0, -0.9);
    shelf.rotation.y = Math.PI / 2;
    g.add(shelf);

    // Plants
    const pl1 = this.makePlant(1.5, true);
    place(pl1, -4.25, -3.05);
    shadowAt(-4.25, -3.05, 0.5, 0.45);
    const pl2 = this.makePlant(1.3, true);
    place(pl2, 4.3, 2.7);
    shadowAt(4.3, 2.7, 0.45, 0.4);
    const pl3 = this.makePlant(0.8);
    place(pl3, 4.35, -2.1);
    this.obstacles.push({ x: -4.25, z: -3.05, r: 0.6 }, { x: 4.3, z: 2.7, r: 0.6 });
  }

  private makeCat(): THREE.Group {
    const cat = new THREE.Group();
    const fur = 0xf3b97a;
    const white = 0xfff3e6;
    const body = sphere(0.2, fur, { ink: 0.012 });
    body.scale.set(1.3, 0.7, 1.0);
    body.position.set(0, 0.12, 0);
    cat.add(body);
    const belly = sphere(0.14, white, undefined, 12, 8);
    belly.scale.set(1.2, 0.5, 0.8);
    belly.position.set(0.02, 0.07, 0.1);
    cat.add(belly);
    const head = sphere(0.13, fur, { ink: 0.012 });
    head.position.set(-0.27, 0.15, 0.08);
    cat.add(head);
    for (const s of [-1, 1]) {
      const ear = cone(0.05, 0.1, fur, 4, { ink: 0.008 });
      ear.position.set(-0.27 + s * 0.07, 0.28, 0.08);
      ear.rotation.z = -s * 0.25;
      cat.add(ear);
      // closed, content eyes
      const eye = box(0.04, 0.008, 0.01, INK);
      eye.position.set(-0.36, 0.17, 0.08 + s * 0.05);
      eye.rotation.y = Math.PI / 2;
      cat.add(eye);
    }
    const nose = sphere(0.012, 0xff7a98, undefined, 6, 4);
    nose.position.set(-0.4, 0.14, 0.08);
    cat.add(nose);
    // tail curled around the body
    for (let i = 0; i < 5; i++) {
      const a = 0.6 + i * 0.55;
      const t = sphere(0.045 - i * 0.003, i > 3 ? white : fur, undefined, 8, 6);
      t.position.set(0.22 - Math.sin(a) * 0.17, 0.07, 0.13 + Math.cos(a) * 0.17);
      cat.add(t);
    }
    return cat;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Wall decor, string lights, pendant lamps, neon sign, clock
  // ───────────────────────────────────────────────────────────────────────────
  private buildDecor() {
    const g = this.group;
    const { z0, h, x0, x1 } = ROOM;

    // Clock between the two windows (shows the real time)
    const clockCx = -1.3;
    const clockY = 2.7;
    g.add(at(cyl(0.36, 0.36, 0.05, C.wood, 28, { ink: 0.014 }), clockCx, clockY, z0 + 0.03).rotateX(Math.PI / 2));
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.31, 36), new THREE.MeshBasicMaterial({ color: 0xfff9f2 }));
    face.position.set(clockCx, clockY, z0 + 0.062);
    g.add(face);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.014, i % 3 === 0 ? 0.05 : 0.025), new THREE.MeshBasicMaterial({ color: INK }));
      tick.position.set(clockCx + Math.sin(a) * 0.26, clockY + Math.cos(a) * 0.26, z0 + 0.064);
      tick.rotation.z = -a;
      g.add(tick);
    }
    const hand = (len: number, wd: number, color: number, zz: number) => {
      const pivot = new THREE.Group();
      const m = new THREE.Mesh(new THREE.PlaneGeometry(wd, len), new THREE.MeshBasicMaterial({ color }));
      m.position.y = len / 2 - 0.02;
      pivot.add(m);
      pivot.userData.dynamic = true;
      pivot.position.set(clockCx, clockY, z0 + zz);
      g.add(pivot);
      return pivot;
    };
    this._hourHand = hand(0.15, 0.022, INK, 0.066);
    this._minHand = hand(0.23, 0.016, INK, 0.068);
    this._secHand = hand(0.26, 0.007, 0xff4f6e, 0.07);

    // Framed pictures on the right wall
    const painting = (kind: number) =>
      canvasTexture(256, 256, (ctx, w, hh) => {
        const gr = ctx.createLinearGradient(0, 0, 0, hh);
        const sets = [
          ["#ffd6e0", "#ffb3c6"],
          ["#c9ecff", "#e8f8ff"],
          ["#ffe9b0", "#ffc98a"],
        ];
        gr.addColorStop(0, sets[kind][0]);
        gr.addColorStop(1, sets[kind][1]);
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, w, hh);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        if (kind === 0) {
          // coffee cup
          ctx.fillRect(80, 110, 96, 80);
          ctx.beginPath();
          ctx.arc(190, 150, 24, -1.5, 1.5);
          ctx.lineWidth = 12;
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.stroke();
          ctx.fillStyle = "#ff8fab";
          ctx.beginPath();
          ctx.arc(128, 150, 14, 0, 6.3);
          ctx.fill();
        } else if (kind === 1) {
          // little cloud + moon
          ctx.beginPath();
          ctx.arc(110, 140, 36, 0, 6.3);
          ctx.arc(150, 130, 44, 0, 6.3);
          ctx.arc(190, 145, 32, 0, 6.3);
          ctx.fill();
        } else {
          // cat face
          ctx.beginPath();
          ctx.arc(128, 140, 60, 0, 6.3);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(78, 100);
          ctx.lineTo(88, 50);
          ctx.lineTo(120, 90);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(178, 100);
          ctx.lineTo(168, 50);
          ctx.lineTo(136, 90);
          ctx.fill();
          ctx.fillStyle = "#3a2630";
          ctx.fillRect(105, 130, 10, 14);
          ctx.fillRect(141, 130, 10, 14);
        }
      });
    [
      { z: -1.9, y: 2.5, k: 0, s: 0.8 },
      { z: -0.6, y: 2.65, k: 1, s: 0.62 },
      { z: 0.5, y: 2.45, k: 2, s: 0.8 },
    ].forEach(({ z, y, k, s }) => {
      const f = new THREE.Group();
      f.add(at(box(0.05, s + 0.12, s + 0.12, C.wood, { ink: 0.01 }), 0, 0, 0));
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: painting(k) }));
      pic.position.x = -0.03;
      pic.rotation.y = -Math.PI / 2;
      f.add(pic);
      f.position.set(x1 - 0.12, y, z);
      g.add(f);
    });

    // Neon "OPEN" sign
    const neonTex = canvasTexture(256, 96, (ctx, w, hh) => {
      ctx.clearRect(0, 0, w, hh);
      ctx.font = "bold 70px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#fff";
      ctx.fillText("OPEN", w / 2, hh / 2 + 4);
    });
    this._neon = new THREE.MeshBasicMaterial({ map: neonTex, transparent: true, color: 0xffb3c6, depthWrite: false });
    const neon = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.32), this._neon);
    neon.position.set(x1 - 0.14, 3.3, 1.7);
    neon.rotation.y = -Math.PI / 2;
    g.add(neon);
    const neonGlow = glowSprite("rgba(255,120,170,0.9)", 1.1, 0.6);
    neonGlow.position.set(x1 - 0.3, 3.3, 1.7);
    g.add(neonGlow);
    this._glows.push(neonGlow);

    // String lights along the top of the back wall
    const bulbGeo = new THREE.SphereGeometry(0.035, 8, 6);
    for (let k = 0; k < 4; k++) this._bulbMats.push(new THREE.MeshBasicMaterial({ color: 0xffdb99 }));
    const n = 26;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const x = x0 + 0.3 + u * (x1 - x0 - 0.6);
      const y = h - 0.32 - Math.sin(u * Math.PI * 3) * 0.06 - Math.sin(u * Math.PI) * 0.0;
      const b = new THREE.Mesh(bulbGeo, this._bulbMats[i % 4]);
      b.position.set(x, y - 0.03 * Math.abs(Math.sin(u * Math.PI * 6)), z0 + 0.1);
      g.add(b);
    }
    g.add(at(box(x1 - x0 - 0.5, 0.012, 0.012, INK), 0, h - 0.3, z0 + 0.1));

    // Pendant lamps in the middle of the room
    const lamp = (x: number, z: number, color: number) => {
      const grp = new THREE.Group();
      grp.add(at(cyl(0.008, 0.008, 1.0, INK, 4), 0, 0.5, 0));
      const shade = cone(0.3, 0.26, color, 24, { ink: 0.014 });
      shade.position.y = -0.05;
      grp.add(shade);
      grp.add(at(sphere(0.06, 0xfff3c4, undefined, 10, 8), 0, -0.1, 0));
      const glow = glowSprite("rgba(255,214,140,0.95)", 0.85, 0.3);
      glow.position.y = -0.35;
      grp.add(glow);
      this._glows.push(glow);
      grp.position.set(x, h - 1.0, z);
      g.add(grp);
    };
    lamp(-1.8, 0.4, C.pink);
    lamp(1.8, 0.4, C.mint);
    lamp(2.2, -2.2, C.butter);
    lamp(3.9, -2.2, C.butter);
    lamp(-2.5, -1.6, C.pinkSoft);
  }

  private buildLighting() {
    // Two warm lamp lights; their intensity follows the time of day.
    const a = new THREE.PointLight(0xffc98a, 0, 9, 1.5);
    a.position.set(2.8, 2.8, -1.4);
    const b = new THREE.PointLight(0xffc98a, 0, 9, 1.5);
    b.position.set(-2.6, 2.8, 0.4);
    this.group.add(a, b);
    this._lights.push(a, b);
  }

  /** True if the straight walk from a to b stays clear of every obstacle. */
  segmentClear(a: Waypoint, b: Waypoint, margin = 0.1): boolean {
    for (const o of this.obstacles) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((o.x - a.x) * dx + (o.z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      if (Math.hypot(o.x - px, o.z - pz) < o.r + margin) return false;
    }
    return true;
  }
}
