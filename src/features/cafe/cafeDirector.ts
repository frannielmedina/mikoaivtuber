import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import type { Model } from "../vrmViewer/model";
import { CafeScene } from "./cafeScene";
import { CafeConfig, DEFAULT_CAFE_CONFIG, sanitizeCafeConfig } from "./cafeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// CafeDirector = the "film crew" for the cafe scene.
//
//   wide shot   the whole cafe; the character strolls between waypoints.
//   close-up    triggered the moment someone talks to her (text box or Twitch):
//               she stops, turns to the camera, the camera pushes in on her
//               face, and she talks with gestures (see talkGestures.ts).
//
// The camera zooms back out once the AI has been idle — not thinking and not
// speaking — for `closeupHoldSeconds` (default 10 s).
//
// While screen-share / gaming mode is active the Viewer deactivates the
// director altogether (see Viewer.updateCafe) and the old corner "facecam"
// framing takes over.
// ─────────────────────────────────────────────────────────────────────────────

export type CafeShot = "wide" | "closeup";

const TAU = Math.PI * 2;
function angleDiff(a: number, b: number) {
  return ((((b - a) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
}

const WIDE_FOV = 50;
const CLOSE_FOV = 28;
const CLOSE_DIST = 1.75;

export class CafeDirector {
  // Built lazily on first use: Viewer is created at module load, which also runs during
  // server-side rendering where there is no `document` for the canvas textures.
  private _cafe?: CafeScene;
  get cafe(): CafeScene {
    if (!this._cafe) {
      this._cafe = new CafeScene();
      this._cafe.setTimeOfDay(this._cfg.timeOfDay);
      this._cafe.setVisible(this._active);
      this._scene.add(this._cafe.group);
    }
    return this._cafe;
  }
  private _scene: THREE.Scene;
  /** Called whenever the Viewer should re-apply lights / camera (active state or time of day changed). */
  onChange?: () => void;

  private _camera?: THREE.PerspectiveCamera;
  private _controls?: OrbitControls;
  private _model?: Model;
  private _cfg: CafeConfig = DEFAULT_CAFE_CONFIG;

  private _active = false;
  private _shot: CafeShot = "wide";
  private _busy = false; // the AI is thinking / answering (set from React)
  private _idleSince = 0; // wall-clock ms when the AI last stopped being busy (the hold timer is real time, not frame time)
  private _time = 0;
  private _snap = true;

  // Character motion (x/z on the floor, yaw in radians; 0 = facing +z / the camera)
  private _pos = new THREE.Vector2(0, 0.9);
  private _yaw = 0;
  private _speed = 0;
  private _next = -1;
  private _last = 0;
  private _pause = 1.5;
  private _restYaw = 0;

  // Camera spring state
  private _camPos = new THREE.Vector3(0, 2.4, 5.0);
  private _camLook = new THREE.Vector3(0, 1.7, -3);
  private _fov = WIDE_FOV;
  private _goalPos = new THREE.Vector3();
  private _goalLook = new THREE.Vector3();
  private _tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  attach(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    this._camera = camera;
    this._controls = controls;
  }

  setConfig(cfg: Partial<CafeConfig>) {
    const next = sanitizeCafeConfig(cfg);
    const todChanged = next.timeOfDay !== this._cfg.timeOfDay;
    this._cfg = next;
    if (todChanged && this._cafe) {
      this._cafe.setTimeOfDay(next.timeOfDay);
      this.onChange?.();
    }
  }

  setModel(model: Model | undefined) {
    this._model = model;
    if (model?.vrm) this.syncModel();
  }

  get active() {
    return this._active;
  }
  get shot() {
    return this._shot;
  }
  get config() {
    return this._cfg;
  }

  /** React → "the AI is currently thinking/answering". */
  setConversationBusy(busy: boolean) {
    this._busy = busy;
    if (busy) this.notifyConversation();
  }

  /** Someone just sent a message: cut to the close-up right away. */
  notifyConversation() {
    this._shot = "closeup";
    this._idleSince = performance.now();
  }

  /** Test / debug helper. */
  forceShot(shot: CafeShot) {
    this._shot = shot;
    this._idleSince = performance.now();
  }

  setActive(active: boolean) {
    if (active === this._active) return;
    this._active = active;
    this.cafe.setVisible(active);
    if (this._controls) this._controls.enabled = !active;
    if (active) {
      this._snap = true;
      this._shot = "wide";
      this._idleSince = performance.now();
      this.syncModel();
    } else {
      this.resetModel();
    }
    this.onChange?.();
  }

  // ── per-frame ──────────────────────────────────────────────────────────────
  update(dt: number) {
    if (!this._active) return;
    this._time += dt;
    this.cafe.update(dt);
    this.updateShotLogic();
    this.updateCharacter(dt);
    this.updateCamera(dt);
  }

  private updateShotLogic() {
    const speaking = !!this._model?.isSpeaking;
    if (this._busy || speaking) {
      this._shot = "closeup";
      this._idleSince = performance.now();
    } else if (this._shot === "closeup") {
      if (performance.now() - this._idleSince >= this._cfg.closeupHoldSeconds * 1000) {
        this._shot = "wide";
        this._pause = 0.6; // start strolling again soon after the zoom-out
      }
    }
  }

  private updateCharacter(dt: number) {
    const model = this._model;
    const vrm = model?.vrm;
    const cam = this._camera;
    if (!model || !vrm || !cam) return;

    const toCam = Math.atan2(cam.position.x - this._pos.x, cam.position.z - this._pos.y);
    const closeup = this._shot === "closeup";
    const bodyBusy = (model.vrmaWeight ?? 0) > 0.05;

    let desired = 0;
    let yawGoal = toCam;
    const wc = this.cafe.waypoints;

    if (!closeup && this._cfg.wander && !bodyBusy) {
      if (this._pause > 0) {
        this._pause -= dt;
        yawGoal = this._restYaw;
        if (this._pause <= 0) this.pickNext();
      } else if (this._next >= 0) {
        const t = wc[this._next];
        const dx = t.x - this._pos.x;
        const dz = t.z - this._pos.y;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.1) {
          // arrived: stand a moment, face roughly toward the viewer, sometimes wave
          this._last = this._next;
          this._next = -1;
          this._pause = 2.8 + Math.random() * 3;
          this._restYaw = toCam + (Math.random() - 0.5) * 0.7;
          if (Math.random() < 0.18) {
            const tags = ["wave", "peacesign", "spin"];
            model.playVrma(tags[Math.floor(Math.random() * tags.length)]).catch(() => {});
          }
        } else {
          yawGoal = Math.atan2(dx, dz);
          const turn = Math.abs(angleDiff(this._yaw, yawGoal));
          desired = this._cfg.walkSpeed * Math.max(0, Math.min(1, 1 - turn / 1.1));
        }
      } else {
        this.pickNext();
        if (this._next < 0) this._pause = 1.5;
      }
    } else if (!closeup) {
      yawGoal = this._restYaw || toCam;
    }

    // Smooth speed + heading
    this._speed += (desired - this._speed) * (1 - Math.exp(-5 * dt));
    if (this._speed < 0.01 && desired === 0) this._speed = 0;
    this._yaw += angleDiff(this._yaw, yawGoal) * (1 - Math.exp(-(closeup ? 5 : 7) * dt));

    if (this._speed > 0) {
      this._pos.x += Math.sin(this._yaw) * this._speed * dt;
      this._pos.y += Math.cos(this._yaw) * this._speed * dt;
    }
    const b = this.cafe.bounds;
    this._pos.x = Math.min(b.maxX, Math.max(b.minX, this._pos.x));
    this._pos.y = Math.min(b.maxZ, Math.max(b.minZ, this._pos.y));

    model.walk?.setSpeed(this._speed);
    vrm.scene.position.x = this._pos.x;
    vrm.scene.position.z = this._pos.y;
    vrm.scene.rotation.y = model.baseYaw + this._yaw;
    this.cafe.modelShadow.position.set(this._pos.x, 0.012, this._pos.y);
  }

  private pickNext() {
    const wc = this.cafe.waypoints;
    const here = { x: this._pos.x, z: this._pos.y };
    const options: number[] = [];
    for (let i = 0; i < wc.length; i++) {
      if (i === this._last) continue;
      if (Math.hypot(wc[i].x - here.x, wc[i].z - here.z) < 0.8) continue;
      if (this.cafe.segmentClear(here, wc[i])) options.push(i);
    }
    this._next = options.length ? options[Math.floor(Math.random() * options.length)] : -1;
  }

  private headWorld(out: THREE.Vector3) {
    const head = this._model?.vrm?.humanoid.getNormalizedBoneNode("head");
    if (head) return head.getWorldPosition(out);
    return out.set(this._pos.x, 1.4, this._pos.y);
  }

  private updateCamera(dt: number) {
    const cam = this._camera;
    if (!cam) return;
    const aspect = cam.aspect || 16 / 9;

    let goalFov: number;
    if (this._shot === "closeup") {
      const h = this.headWorld(this._tmp);
      const dist = CLOSE_DIST / this._cfg.closeupZoom;
      this._goalPos.set(h.x + 0.08, h.y - 0.04, h.z + dist);
      this._goalLook.set(h.x, h.y - 0.16, h.z);
      goalFov = CLOSE_FOV;
    } else {
      // Pull back further for narrow (portrait-ish) windows so the whole room still fits.
      const back = Math.min(8, Math.max(0, (1.7 / aspect - 1) * 6));
      const sway = Math.sin(this._time * 0.2) * 0.1;
      this._goalPos.set(this._pos.x * 0.18 + sway, 2.4, 5.0 + back);
      this._goalLook.set(this._pos.x * 0.3, 1.3, -1);
      goalFov = WIDE_FOV;
    }

    const k = this._snap ? 1 : 1 - Math.exp(-2.6 * dt);
    this._snap = false;
    this._camPos.lerp(this._goalPos, k);
    this._camLook.lerp(this._goalLook, k);
    this._fov += (goalFov - this._fov) * k;

    cam.position.copy(this._camPos);
    cam.lookAt(this._camLook);
    if (Math.abs(cam.fov - this._fov) > 0.001) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.cafe.updateGrade(cam);
  }

  // ── model placement ────────────────────────────────────────────────────────
  private syncModel() {
    const vrm = this._model?.vrm;
    if (!vrm || !this._model) return;
    vrm.scene.position.set(this._pos.x, 0, this._pos.y);
    vrm.scene.rotation.y = this._model.baseYaw + this._yaw;
  }

  /** Put the character back at the origin facing the camera (used when leaving the cafe). */
  private resetModel() {
    const m = this._model;
    const vrm = m?.vrm;
    m?.walk?.setSpeed(0);
    this._speed = 0;
    if (vrm && m) {
      vrm.scene.position.set(0, 0, 0);
      vrm.scene.rotation.y = m.baseYaw;
    }
  }
}
