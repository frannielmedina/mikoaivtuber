import * as THREE from "three";

// ── Shared helpers for the anime-style (cel-shaded) cafe ─────────────────────
// Everything is MeshToonMaterial with one shared 4-step gradient, plus an
// "inverted hull" ink outline on the pieces that need a manga-style edge.

let _gradient: THREE.DataTexture | null = null;
export function toonGradient(): THREE.DataTexture {
  if (_gradient) return _gradient;
  const data = new Uint8Array([120, 175, 225, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _gradient = tex;
  return tex;
}

const _matCache = new Map<string, THREE.MeshToonMaterial>();

/**
 * Cached toon material. `glow` lifts the shadow side with a little emissive of
 * the same colour, so the cafe stays bright and flat-coloured like an anime
 * background instead of depending on the scene's directional light.
 */
export function toon(color: number | string, glow = 0.12): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}:${glow}`;
  let m = _matCache.get(key);
  if (!m) {
    const c = new THREE.Color(color);
    m = new THREE.MeshToonMaterial({
      color: c,
      gradientMap: toonGradient(),
      emissive: c.clone().multiplyScalar(glow),
    });
    _matCache.set(key, m);
  }
  return m;
}

export const INK = 0x3a2630; // warm dark plum instead of pure black
export const inkMaterial = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
const _inkMat = inkMaterial;

/** Adds a manga-style ink outline to a mesh (inverted hull, `thick` metres). */
export function outline(mesh: THREE.Mesh, thick = 0.018): THREE.Mesh {
  const geo = mesh.geometry;
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox!.getSize(size);
  const s = (n: number) => (n > 1e-4 ? (n + thick * 2) / n : 1);
  const hull = new THREE.Mesh(geo, _inkMat);
  hull.scale.set(s(size.x), s(size.y), s(size.z));
  // Keep the hull centred on the geometry's own centre, not the mesh origin.
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  hull.position.set(c.x * (1 - hull.scale.x), c.y * (1 - hull.scale.y), c.z * (1 - hull.scale.z));
  hull.userData.isOutline = true;
  mesh.add(hull);
  return mesh;
}

export type MeshOpts = { ink?: boolean | number; glow?: number };

function finish(m: THREE.Mesh, o?: MeshOpts) {
  if (o?.ink) outline(m, typeof o.ink === "number" ? o.ink : 0.018);
  return m;
}

export function box(w: number, h: number, d: number, color: number | string, o?: MeshOpts) {
  return finish(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color, o?.glow)), o);
}
export function cyl(rt: number, rb: number, h: number, color: number | string, seg = 20, o?: MeshOpts) {
  return finish(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), toon(color, o?.glow)), o);
}
export function sphere(r: number, color: number | string, o?: MeshOpts, ws = 18, hs = 12) {
  return finish(new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), toon(color, o?.glow)), o);
}
export function cone(r: number, h: number, color: number | string, seg = 18, o?: MeshOpts) {
  return finish(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), toon(color, o?.glow)), o);
}
export function flat(w: number, h: number, color: number | string) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color }));
}

export function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, y, z);
  return o;
}

// ── Canvas textures ──────────────────────────────────────────────────────────
export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 4;
  return t;
}

/** Soft round blob (used for fake contact shadows and lamp glows). */
export function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Fake contact shadow: a dark soft ellipse lying on the floor. */
export function blobShadow(rx: number, rz: number, opacity = 0.28): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: radialTexture(`rgba(60,30,40,${opacity})`, "rgba(60,30,40,0)"),
    transparent: true,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(rx * 2, rz * 2), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.008;
  m.renderOrder = 1;
  return m;
}

/** Additive glow sprite for lamps. */
export function glowSprite(color: string, size: number, opacity = 0.9): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: radialTexture(color, "rgba(255,255,255,0)"),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(mat);
  s.renderOrder = 10; // above the colour grade so lamps still glow at night
  s.scale.set(size, size, 1);
  return s;
}

export function mulberry(seed: number) {
  // Tiny deterministic RNG so the cafe looks identical on every load.
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
