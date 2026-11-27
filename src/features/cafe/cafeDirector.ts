import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import type { Model } from "../vrmViewer/model";
import { CafeScene, Seat, Waypoint } from "./cafeScene";
import { ActivityName, CafeConfig, DEFAULT_CAFE_CONFIG, sanitizeCafeConfig } from "./cafeConfig";
import { bone } from "./ik";
import { ArmGoal } from "./actionController";
import { BOARD_TOP_Y } from "./cafeProps";
import { Connect4Session, gameManager } from "../games/gameManager";
import { Clip, projectorStore } from "../projector/projectorStore";

// ─────────────────────────────────────────────────────────────────────────────
// CafeDirector = the "film crew + choreographer" for the cafe scene.
//
//  Camera
//    A BASE shot (wide / game / pet / screen) that follows what she is doing, plus
//    the close-up that cuts in whenever someone talks to her and — once the AI has
//    been idle for `closeupHoldSeconds` — zooms back out to the base shot.
//
//  Behaviour
//    Free wandering between waypoints, and "activities" made of small steps
//    (walk, sit, stand, pat the cat, serve coffee …). Activities are started by
//    the scheduler while she wanders, or on demand: a Connect 4 game sits her at
//    the table, `!so` walks her to the projector screen.
//    A chat close-up does NOT interrupt an activity — she keeps doing it while
//    talking (hands are released for talking gestures while she speaks).
// ─────────────────────────────────────────────────────────────────────────────

export type BaseShot = "wide" | "follow" | "game" | "pet" | "screen";
export type CafeShot = BaseShot | "closeup";

type Step = { name: string; enter?: () => void; run: (dt: number) => boolean; exit?: () => void };

const TAU = Math.PI * 2;
const angleDiff = (a: number, b: number) => ((((b - a) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
const now = () => performance.now() / 1000;

const CLOSE_FOV = 28;
const CLOSE_DIST = 1.75;
const SEAT_HIP_ABOVE_SEAT = 0.09; // hips sit this far above the seat surface
const CHAIR_SLIDE = 0.35; // how far a chair slides when pulled out
const SEATED_PULL = 0.25;

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
  private _base: BaseShot = "wide";
  private _closeup = false;
  private _busy = false;
  private _idleSince = 0; // wall-clock ms: the hold timer is real time, not frame time
  private _time = 0;
  private _snap = true;

  // ── character kinematics ──
  private _pos = new THREE.Vector2(0, 0.9);
  private _yaw = 0;
  private _speed = 0;
  private _desiredSpeed = 0;
  private _yawGoal: number | null = null;
  private _sitAmt = 0;
  private _seat: Seat | null = null;
  private _twist = 0;
  private _twistK = 0;
  private _headPitch = 0;

  // ── free wander ──
  private _next = -1;
  private _last = 0;
  private _pause = 1.5;
  private _restYaw = 0;
  private _cooldownUntil = 0;

  // ── activity engine ──
  private _activity: string | null = null;
  private _queue: Step[] = [];
  private _cur: Step | null = null;
  private _cleanups: (() => void)[] = [];
  private _arms: { left: ArmGoal | null; right: ArmGoal | null } = { left: null, right: null };
  private _pulls = new Map<string, { cur: number; tgt: number }>();
  private _tucks: { seat: Seat; at: number }[] = [];
  private _cupTimers: { table: number; until: number }[] = [];

  // ── game ──
  private _game: Connect4Session | null = null;
  private _lastMoves = -1;
  private _dropCol = -1;
  private _dropT = 99;

  // ── camera spring ──
  private _camPos = new THREE.Vector3(0, 2.4, 5.0);
  private _camLook = new THREE.Vector3(0, 1.3, -1);
  private _fov = 50;
  private _goalPos = new THREE.Vector3();
  private _goalLook = new THREE.Vector3();
  private _goalFov = 50;

  // scratch + per-frame body frame
  private _t1 = new THREE.Vector3();
  private _t2 = new THREE.Vector3();
  private _fwd = new THREE.Vector3(0, 0, 1);
  private _left = new THREE.Vector3(1, 0, 0);
  private _hips = new THREE.Vector3();
  private _head = new THREE.Vector3();
  private _shoulder = { left: new THREE.Vector3(), right: new THREE.Vector3() };

  constructor(scene: THREE.Scene) {
    this._scene = scene;
    gameManager.subscribe((s) => this.onGame(s));
    projectorStore.subscribe(() => this.syncProjector());
    projectorStore.onRequest((c) => this.onClipRequest(c));
  }

  // ───────────────────────────── wiring ─────────────────────────────
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
    if (model?.vrm && this._active) this.placeModel();
  }

  get active() {
    return this._active;
  }
  get shot(): CafeShot {
    return this._closeup ? "closeup" : this._base;
  }
  get baseShot() {
    return this._base;
  }
  get config() {
    return this._cfg;
  }
  /** For tests / debugging. */
  get debug() {
    return {
      activity: this._activity,
      step: this._cur?.name ?? null,
      queued: this._queue.length,
      sit: +this._sitAmt.toFixed(2),
      seat: this._seat?.id ?? null,
      pos: [+this._pos.x.toFixed(2), +this._pos.y.toFixed(2)],
    };
  }

  setConversationBusy(busy: boolean) {
    this._busy = busy;
    if (busy) this.notifyConversation();
  }

  /** Someone just sent a message: cut to the close-up right away. */
  notifyConversation() {
    this._closeup = true;
    this._idleSince = performance.now();
  }

  /** Test / debug helper. */
  forceShot(shot: CafeShot) {
    if (shot === "closeup") this.notifyConversation();
    else {
      this._closeup = false;
      this._base = shot;
    }
  }

  setActive(active: boolean) {
    if (active === this._active) return;
    this._active = active;
    if (active) {
      const c = this.cafe;
      c.setVisible(true);
      if (this._controls) this._controls.enabled = false;
      this._snap = true;
      this._closeup = false;
      this._base = "wide";
      this._idleSince = performance.now();
      c.board.setSession(this._game);
      this.placeModel();
      this.syncProjector();
      if (this._game?.status === "playing") this.startGame();
    } else {
      this.resetAll();
      this._cafe?.setVisible(false);
      if (this._controls) this._controls.enabled = true;
    }
    this.onChange?.();
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dt: number) {
    if (!this._active) return;
    this._time += dt;
    const cafe = this.cafe;
    this.updateShotLogic();
    this.updateFrame();
    this.updateCharacter(dt);
    this.applyBody(dt);
    this.updateChairs(dt);
    cafe.projector.setLit(!!projectorStore.state.source || projectorStore.state.phase === "playing");
    cafe.update(dt);
    this.updateCupTimers();
    this.updateCamera(dt);
    this.updateProjectorQuad();
  }

  private updateShotLogic() {
    const speaking = !!this._model?.isSpeaking;
    if (this._busy || speaking) {
      this._closeup = true;
      this._idleSince = performance.now();
    } else if (this._closeup) {
      if (performance.now() - this._idleSince >= this._cfg.closeupHoldSeconds * 1000) {
        this._closeup = false; // zoom back out to whatever the base shot is
        if (!this._activity) this._pause = Math.min(this._pause, 0.6);
      }
    }
  }

  /** Per-frame body frame: forward / anatomical-left directions, hips and head in world space. */
  private updateFrame() {
    const vrm = this._model?.vrm;
    if (!vrm) return;
    this._fwd.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    const L = bone(vrm, "leftUpperArm");
    const R = bone(vrm, "rightUpperArm");
    if (L && R) {
      L.getWorldPosition(this._shoulder.left);
      R.getWorldPosition(this._shoulder.right);
      this._left.subVectors(this._shoulder.left, this._shoulder.right);
      this._left.y = 0;
      if (this._left.lengthSq() > 1e-6) this._left.normalize();
    }
    bone(vrm, "hips")?.getWorldPosition(this._hips);
    bone(vrm, "head")?.getWorldPosition(this._head);
  }

  // ───────────────────────── character: wander + activities ─────────────────────────
  private updateCharacter(dt: number) {
    const model = this._model;
    const vrm = model?.vrm;
    const cam = this._camera;
    if (!model || !vrm || !cam) return;

    this._desiredSpeed = 0;
    this._yawGoal = null;
    this._arms.left = null;
    this._arms.right = null;
    this._twistK = 0;
    this._headPitch = 0;

    const toCam = Math.atan2(cam.position.x - this._pos.x, cam.position.z - this._pos.y);

    if (this._activity) {
      this.runActivity(dt);
    } else if (this._seat) {
      // (safety) never wander while still seated
      this.startSteps("stand-up", [this.stepStand(this._seat)], "wide");
    } else {
      this.wander(dt, toCam);
    }

    // heading + speed + position
    this._speed += (this._desiredSpeed - this._speed) * (1 - Math.exp(-5 * dt));
    if (this._speed < 0.01 && this._desiredSpeed === 0) this._speed = 0;
    if (this._yawGoal !== null) {
      this._yaw += angleDiff(this._yaw, this._yawGoal) * (1 - Math.exp(-(this._closeup ? 5 : 7) * dt));
    }
    if (this._speed > 0) {
      this._pos.x += Math.sin(this._yaw) * this._speed * dt;
      this._pos.y += Math.cos(this._yaw) * this._speed * dt;
    }
    this._pos.x = clamp(this._pos.x, -4.4, 4.4);
    this._pos.y = clamp(this._pos.y, -3.45, 3.5);
    model.walk?.setSpeed(this._speed);
  }

  private wander(dt: number, toCam: number) {
    const model = this._model!;
    const bodyBusy = (model.vrmaWeight ?? 0) > 0.05;
    const wc = this.cafe.waypoints;

    if (this._closeup) {
      this._yawGoal = toCam; // stop and face the camera
      return;
    }
    if (!this._cfg.wander || bodyBusy) {
      this._yawGoal = this._restYaw || toCam;
      return;
    }
    if (this._pause > 0) {
      this._pause -= dt;
      this._yawGoal = this._restYaw;
      if (this._pause <= 0) this.pickNext();
      return;
    }
    if (this._next < 0) {
      this.pickNext();
      if (this._next < 0) this._pause = 1.5;
      return;
    }
    const t = wc[this._next];
    if (this.steer(t.x, t.z, { arrive: 0.1 })) {
      this._last = this._next;
      this._next = -1;
      this._pause = 2.8 + Math.random() * 3;
      this._restYaw = toCam + (Math.random() - 0.5) * 0.7;
      if (this.maybeStartActivity()) return;
      if (Math.random() < 0.18) {
        const tags = ["wave", "peacesign", "spin"];
        model.playVrma(tags[Math.floor(Math.random() * tags.length)]).catch(() => {});
      }
    }
  }

  private pickNext() {
    const wc = this.cafe.waypoints;
    const here = { x: this._pos.x, z: this._pos.y };
    const options: number[] = [];
    let nearest = -1;
    let nd = 1e9;
    for (let i = 0; i < wc.length; i++) {
      const d = Math.hypot(wc[i].x - here.x, wc[i].z - here.z);
      if (d < 0.8) continue;
      if (d < nd) {
        nd = d;
        nearest = i;
      }
      if (i !== this._last && this.cafe.segmentClear(here, wc[i])) options.push(i);
    }
    // if she is boxed in (e.g. just left a chair) head for the nearest waypoint anyway
    this._next = options.length ? options[Math.floor(Math.random() * options.length)] : nearest;
  }

  /** Walk toward a floor point. Returns true once within `arrive` metres. */
  private steer(tx: number, tz: number, o: { speed?: number; arrive?: number } = {}): boolean {
    const dx = tx - this._pos.x;
    const dz = tz - this._pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < (o.arrive ?? 0.08)) return true;
    const goal = Math.atan2(dx, dz);
    this._yawGoal = goal;
    const turn = Math.abs(angleDiff(this._yaw, goal));
    this._desiredSpeed = (o.speed ?? this._cfg.walkSpeed) * clamp(1 - turn / 1.1, 0, 1);
    return false;
  }

  // ───────────────────────── activity engine ─────────────────────────
  private startSteps(name: string, steps: Step[], base: BaseShot) {
    this.endActivity(false);
    this._activity = name;
    this._queue = steps;
    this._cur = null;
    this._base = base;
    this._next = -1;
  }

  private runActivity(dt: number) {
    if (!this._cur) {
      this._cur = this._queue.shift() ?? null;
      if (!this._cur) {
        this.endActivity(true);
        return;
      }
      this._cur.enter?.();
    }
    if (this._cur.run(dt)) {
      this._cur.exit?.();
      this._cur = null;
    }
  }

  /** Finish/abort the current activity (runs cleanups). `natural` = it ran to the end. */
  private endActivity(natural: boolean) {
    if (this._cur) this._cur.exit?.();
    this._cur = null;
    this._queue = [];
    this._cleanups.forEach((f) => f());
    this._cleanups = [];
    if (this._activity) {
      this._activity = null;
      this._base = "wide";
      this._pause = 1.0;
      if (natural) this._cooldownUntil = now() + 15;
    }
  }

  /** Steps that make sure she is standing before something else starts. */
  private standFirst(): Step[] {
    return this._seat ? [this.stepStand(this._seat)] : [];
  }

  /** Start one of the idle activities right now. Returns false if she can't. */
  triggerActivity(name: ActivityName): boolean {
    if (!this._active || !this._model?.vrm) return false;
    const plan = name === "sit" ? this.buildSit() : name === "cat" ? this.buildCat() : this.buildCoffee();
    if (!plan) return false;
    this.startSteps(name, [...this.standFirst(), ...plan.steps], plan.base);
    plan.setup?.();
    return true;
  }

  private maybeStartActivity(): boolean {
    const cfg = this._cfg;
    if (cfg.activityRate === "off" || this._closeup || now() < this._cooldownUntil) return false;
    const enabled = (["sit", "cat", "coffee"] as ActivityName[]).filter((n) => cfg.activities[n]);
    if (!enabled.length) return false;
    const p = { rare: 0.12, normal: 0.3, often: 0.55 }[cfg.activityRate];
    if (Math.random() > p) return false;
    return this.triggerActivity(enabled[Math.floor(Math.random() * enabled.length)]);
  }

  // ───────────────────────── step library ─────────────────────────
  private stepWait(sec: number): Step {
    let t0 = 0;
    return { name: "wait", enter: () => (t0 = now()), run: () => now() - t0 >= sec };
  }

  /** Walk through points (evaluated when the step starts), then settle exactly on the last one. */
  private stepWalk(points: () => Waypoint[], o: { yaw?: number; speed?: number } = {}): Step {
    let pts: Waypoint[] = [];
    let i = 0;
    let settle = 0;
    return {
      name: "walk",
      enter: () => {
        pts = points();
        i = 0;
        settle = 0;
      },
      run: (dt) => {
        if (i < pts.length) {
          const last = i === pts.length - 1;
          if (this.steer(pts[i].x, pts[i].z, { speed: o.speed, arrive: last ? 0.1 : 0.3 })) i++;
          return false;
        }
        const L = pts[pts.length - 1];
        const k = 1 - Math.exp(-12 * dt);
        this._pos.x += (L.x - this._pos.x) * k;
        this._pos.y += (L.z - this._pos.y) * k;
        if (o.yaw !== undefined) this._yawGoal = o.yaw;
        settle += dt;
        const yawOk = o.yaw === undefined || Math.abs(angleDiff(this._yaw, o.yaw)) < 0.06;
        return (settle > 0.25 && yawOk && Math.hypot(L.x - this._pos.x, L.z - this._pos.y) < 0.03) || settle > 1.6;
      },
    };
  }

  /** Route around furniture: direct if clear, else via the best waypoint. */
  private planPath(from: Waypoint, to: Waypoint): Waypoint[] {
    const c = this.cafe;
    if (c.segmentClear(from, to, 0.1)) return [to];
    let best: Waypoint | null = null;
    let bd = 1e9;
    for (const w of c.waypoints) {
      if (!c.segmentClear(from, w) || !c.segmentClear(w, to)) continue;
      const d = Math.hypot(w.x - from.x, w.z - from.z) + Math.hypot(w.x - to.x, w.z - to.z);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best ? [best, to] : [to];
  }

  // ── seats ──
  private front(seat: Seat) {
    return { x: Math.sin(seat.yaw), z: Math.cos(seat.yaw) };
  }
  private chairSlide(seat: Seat) {
    return seat.kind === "chair" ? CHAIR_SLIDE : 0;
  }
  /** Where she stands when about to sit / just after getting up (chair pulled out behind her). */
  private standSpot(seat: Seat): Waypoint {
    const f = this.front(seat);
    const s = this.chairSlide(seat);
    return { x: seat.x - f.x * s + f.x * 0.4, z: seat.z - f.z * s + f.z * 0.4 };
  }
  /** Hip position when seated, for a given chair pull-out amount. */
  private seatHip(seat: Seat, pull: number): Waypoint {
    const f = this.front(seat);
    const s = this.chairSlide(seat) * pull;
    const back = seat.kind === "chair" ? 0.04 : 0;
    return { x: seat.x - f.x * s - f.x * back, z: seat.z - f.z * s - f.z * back };
  }
  private pullOf(seat: Seat) {
    return this._pulls.get(seat.id)?.cur ?? 0;
  }
  private setPull(seat: Seat, tgt: number) {
    const e = this._pulls.get(seat.id) ?? { cur: 0, tgt: 0 };
    e.tgt = tgt;
    this._pulls.set(seat.id, e);
  }

  private updateChairs(dt: number) {
    const t = now();
    this._tucks = this._tucks.filter((k) => {
      if (t < k.at) return true;
      this.setPull(k.seat, 0);
      return false;
    });
    this._pulls.forEach((e, id) => {
      const d = e.tgt - e.cur;
      if (Math.abs(d) > 1e-4) e.cur += Math.sign(d) * Math.min(Math.abs(d), dt * 2.4);
      const seat = this.cafe.seats.find((s) => s.id === id);
      if (seat) this.cafe.moveChair(seat, e.cur);
    });
  }

  /** Walk to a seat from the side, ending in front of it, facing the way she will sit. */
  private stepApproach(seat: Seat): Step {
    const P0 = this.standSpot(seat);
    const f = this.front(seat);
    return this.stepWalk(
      () => {
        const here = { x: this._pos.x, z: this._pos.y };
        const sides = [
          { x: P0.x + f.z * 0.95, z: P0.z - f.x * 0.95 },
          { x: P0.x - f.z * 0.95, z: P0.z + f.x * 0.95 },
        ];
        sides.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
        const A = this.cafe.segmentClear(here, sides[0]) || !this.cafe.segmentClear(here, sides[1]) ? sides[0] : sides[1];
        return [...this.planPath(here, A), P0];
      },
      { yaw: seat.yaw, speed: Math.min(this._cfg.walkSpeed, 0.9) }
    );
  }

  private stepSit(seat: Seat): Step {
    let t = 0;
    let scooted = false;
    const P0 = this.standSpot(seat);
    return {
      name: "sit",
      enter: () => {
        t = 0;
        scooted = false;
        this._seat = seat;
        this.setPull(seat, 1);
      },
      run: (dt) => {
        t += dt;
        this._yawGoal = seat.yaw;
        if (t < 0.5) return false; // chair slides out
        if (t < 1.6) {
          const e = smooth((t - 0.5) / 1.1);
          this._sitAmt = e;
          const h = this.seatHip(seat, 1);
          this._pos.set(P0.x + (h.x - P0.x) * e, P0.z + (h.z - P0.z) * e);
          return false;
        }
        if (!scooted) {
          scooted = true;
          this.setPull(seat, SEATED_PULL); // scoot in
        }
        const h = this.seatHip(seat, this.pullOf(seat));
        this._sitAmt = 1;
        this._pos.set(h.x, h.z);
        return t > 2.3;
      },
    };
  }

  private stepStand(seat: Seat): Step {
    let t = 0;
    const P0 = this.standSpot(seat);
    return {
      name: "stand",
      enter: () => {
        t = 0;
        this.setPull(seat, 1); // push the chair back
      },
      run: (dt) => {
        t += dt;
        this._yawGoal = seat.yaw;
        if (t < 0.5) {
          const h = this.seatHip(seat, this.pullOf(seat));
          this._pos.set(h.x, h.z);
          return false;
        }
        const e = 1 - smooth((t - 0.5) / 1.0);
        this._sitAmt = e;
        const h = this.seatHip(seat, 1);
        this._pos.set(P0.x + (h.x - P0.x) * e, P0.z + (h.z - P0.z) * e);
        if (t < 1.5) return false;
        this._sitAmt = 0;
        this._pos.set(P0.x, P0.z);
        this._seat = null;
        this._tucks.push({ seat, at: now() + 1.6 }); // tuck the chair in once she has walked off
        return true;
      },
    };
  }

  // ── arm helpers ──
  private setArms(left: ArmGoal | null, right: ArmGoal | null) {
    if (this._model?.isSpeaking) return; // leave the arms free for talking gestures
    this._arms.left = left;
    this._arms.right = right;
  }
  private goal(target: THREE.Vector3, side: "left" | "right", out = 0.6): ArmGoal {
    // elbow bends down and away from the body
    const s = side === "left" ? 1 : -1;
    const hint = new THREE.Vector3(0, -1, 0).addScaledVector(this._left, s * out).addScaledVector(this._fwd, -0.4);
    return { target: target.clone(), hint };
  }

  // ───────────────────────── activity builders ─────────────────────────
  private pickSeat(): Seat | null {
    const seats = this.cafe.seats.filter((s) => s.id !== "bench" && Math.abs(angleDiff(s.yaw, Math.PI)) > 0.8);
    return seats.length ? seats[Math.floor(Math.random() * seats.length)] : null;
  }

  /** Sit at a table for `sitSeconds`, sipping coffee, then get up and carry on. */
  private buildSit(): { steps: Step[]; base: BaseShot; setup?: () => void } | null {
    const seat = this.pickSeat();
    if (!seat) return null;
    const secs = this._cfg.sitSeconds;
    const cup = this.cafe.handCup;
    let t0 = 0;
    const idle: Step = {
      name: "sit-idle",
      enter: () => (t0 = now()),
      run: () => {
        this.seatedRest(seat, true);
        this._twistK = 0.55;
        return now() - t0 >= secs;
      },
      exit: () => (cup.visible = false),
    };
    return {
      steps: [this.stepApproach(seat), this.stepSit(seat), idle, this.stepStand(seat)],
      base: "wide",
      setup: () => this._cleanups.push(() => (cup.visible = false)),
    };
  }

  /** Hands resting on the table (right hand holds a cup and sips every few seconds). */
  private seatedRest(seat: Seat, cup: boolean) {
    const T = seat.table >= 0 ? this.cafe.tables[seat.table] : null;
    const y = seat.table >= 0 ? BOARD_TOP_Y : seat.topY + 0.16;
    const hip = this._hips;
    const rest = (side: number, k: number, x: number) => {
      const p = new THREE.Vector3();
      if (T) p.set(hip.x + (T.x - hip.x) * k, y + 0.015, hip.z + (T.z - hip.z) * k);
      else p.set(hip.x + this._fwd.x * 0.27, y, hip.z + this._fwd.z * 0.27);
      return p.addScaledVector(this._left, side * x);
    };
    const leftT = rest(1, 0.36, 0.17);
    const rightT = rest(-1, 0.42, 0.12);

    // sip: bring the cup to the mouth for a moment every 9 s
    const ph = now() % 9;
    let u = 0;
    if (cup && ph < 2.0) {
      const x = ph / 2.0;
      u = smooth(x / 0.35) * (1 - smooth((x - 0.65) / 0.35));
    }
    const mouth = this._t2.copy(this._head).addScaledVector(this._fwd, 0.13);
    mouth.y -= 0.07;
    const r = rightT.clone().lerp(mouth, u);
    this.setArms(this.goal(leftT, "left"), this.goal(r, "right"));

    this.cafe.handCup.visible = cup && !this._model?.isSpeaking;
    this.cafe.handCup.position.set(r.x, r.y - 0.04, r.z);
  }

  /** Sit on the window bench and pat the cat; the camera moves in to show it. */
  private buildCat(): { steps: Step[]; base: BaseShot; setup?: () => void } | null {
    const seat = this.cafe.seats.find((s) => s.id === "bench");
    if (!seat) return null;
    const cafe = this.cafe;
    const cat = (cafe as any)._cat as THREE.Group | undefined;
    let t0 = 0;
    const pat: Step = {
      name: "pat",
      enter: () => {
        t0 = now();
        this._base = "pet";
        cafe.hearts.active = true;
        this._model?.emoteController?.playEmotion("happy");
      },
      run: () => {
        const t = now() - t0;
        const dl = this._shoulder.left.distanceTo(cafe.catSpot);
        const dr = this._shoulder.right.distanceTo(cafe.catSpot);
        const side: "left" | "right" = dl < dr ? "left" : "right";
        const w = 2 * Math.PI * 1.7;
        // stroke along the cat's back, pressing a little on each pass
        const target = cafe.catSpot.clone();
        target.x += Math.sin(w * t) * 0.07;
        target.y += 0.012 * (1 + Math.sin(w * t * 2));
        target.z += Math.cos(w * t) * 0.015;
        const restSide = side === "left" ? "right" : "left";
        const hip = this._hips;
        const lap = new THREE.Vector3(hip.x + this._fwd.x * 0.25, seat.topY + 0.17, hip.z + this._fwd.z * 0.25).addScaledVector(
          this._left,
          restSide === "left" ? 0.14 : -0.14
        );
        const gPat = this.goal(target, side, 0.9);
        const gLap = this.goal(lap, restSide);
        this.setArms(side === "left" ? gPat : gLap, side === "left" ? gLap : gPat);
        this._headPitch = 0.32;
        this._twistK = 0;
        if (cat) cat.rotation.z = Math.sin(w * t) * 0.03; // the cat leans into the hand
        return t >= 14;
      },
      exit: () => {
        cafe.hearts.active = false;
        this._model?.emoteController?.playEmotion("neutral");
        if (cat) cat.rotation.z = 0;
      },
    };
    return {
      steps: [this.stepApproach(seat), this.stepSit(seat), pat, this.stepStand(seat)],
      base: "wide",
      setup: () =>
        this._cleanups.push(() => {
          cafe.hearts.active = false;
          if (cat) cat.rotation.z = 0;
        }),
    };
  }

  /** Make a coffee at the counter, carry it on a tray to a table and put it down. */
  private buildCoffee(): { steps: Step[]; base: BaseShot; setup?: () => void } | null {
    const cafe = this.cafe;
    const spots = cafe.serveSpots;
    if (!spots.length) return null;
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const cs = cafe.counterSpot;
    const tray = cafe.tray;
    let t0 = 0;

    const heldTray = (lift = 0, forward = 0.36) => {
      const c = new THREE.Vector3(this._pos.x + this._fwd.x * forward, this._model!.hipsHeight + 0.12 + lift, this._pos.y + this._fwd.z * forward);
      tray.group.position.copy(c);
      tray.group.rotation.y = this._yaw;
      return c;
    };
    const bothHands = (c: THREE.Vector3) => {
      const l = c.clone().addScaledVector(this._left, 0.17);
      const r = c.clone().addScaledVector(this._left, -0.17);
      this.setArms(this.goal(l, "left", 0.5), this.goal(r, "right", 0.5));
    };

    const toCounter = this.stepWalk(() => this.planPath({ x: this._pos.x, z: this._pos.y }, cs), {
      yaw: Math.PI,
      speed: Math.min(this._cfg.walkSpeed, 0.9),
    });

    const prepare: Step = {
      name: "prepare",
      enter: () => {
        t0 = now();
        this._model?.emoteController?.playEmotion("happy");
      },
      run: () => {
        const t = now() - t0;
        const m = cafe.machinePoint;
        const press = m.clone();
        press.x += Math.sin(t * 7) * 0.03;
        press.y += Math.cos(t * 7) * 0.02;
        const cupSide = m.clone().addScaledVector(this._left, 0.3);
        cupSide.y -= 0.12;
        cupSide.z += 0.08;
        this.setArms(this.goal(cupSide, "left", 0.4), this.goal(press, "right", 0.4));
        this._headPitch = 0.1;
        if (t > 2.2 && !tray.group.visible) {
          tray.group.visible = true;
          tray.cup.visible = true;
        }
        if (tray.group.visible) heldTray(-0.05, 0.3);
        return t >= 3.0;
      },
    };

    const toTable = this.stepWalk(() => this.planPath({ x: this._pos.x, z: this._pos.y }, spot.stand), {
      yaw: spot.yaw,
      speed: Math.min(this._cfg.walkSpeed, 0.75),
    });
    // keep the tray in her hands while she walks
    const carrying: Step = {
      name: "carry",
      enter: () => toTable.enter?.(),
      run: (dt) => {
        const done = toTable.run(dt);
        bothHands(heldTray());
        return done;
      },
    };

    const place: Step = {
      name: "place",
      enter: () => (t0 = now()),
      run: () => {
        const t = now() - t0;
        const cup = spot.cup;
        const down = new THREE.Vector3(cup.x, cup.y + 0.045, cup.z);
        const start = new THREE.Vector3(this._pos.x + this._fwd.x * 0.36, this._model!.hipsHeight + 0.12, this._pos.y + this._fwd.z * 0.36);
        const e = t < 1.0 ? smooth(t / 1.0) : t < 1.5 ? 1 : 1 - smooth((t - 1.5) / 0.8);
        const c = start.lerp(down, e);
        tray.group.position.copy(c);
        bothHands(c);
        this._headPitch = 0.15;
        if (t >= 1.25 && tray.cup.visible) {
          tray.cup.visible = false;
          const sc = cafe.serveCups[spot.table];
          if (sc) sc.visible = true;
          this._cupTimers.push({ table: spot.table, until: now() + 28 });
        }
        return t >= 2.3;
      },
      exit: () => {
        tray.group.visible = false;
        this._model?.emoteController?.playEmotion("neutral");
      },
    };

    return {
      steps: [toCounter, prepare, carrying, place, this.stepWait(0.8)],
      base: "follow",
      setup: () => this._cleanups.push(() => (tray.group.visible = false)),
    };
  }

  private updateCupTimers() {
    if (!this._cupTimers.length) return;
    const t = now();
    this._cupTimers = this._cupTimers.filter((c) => {
      if (t < c.until) return true;
      const cup = this.cafe.serveCups[c.table];
      if (cup) cup.visible = false;
      return false;
    });
  }

  // ───────────────────────── Connect 4 ─────────────────────────
  private onGame(s: Connect4Session | null) {
    const prev = this._game;
    this._game = s;
    this._cafe?.board.setSession(s);
    if (s && s.lastMove?.who === 2 && s.moves !== this._lastMoves) {
      this._dropCol = s.lastMove.col;
      this._dropT = 0;
    }
    this._lastMoves = s?.moves ?? -1;
    if (s?.status === "playing" && prev?.status !== "playing" && this._active) this.startGame();
  }

  /** Walk to the table, sit, show the 3D board; when the game ends the board goes away and she gets up. */
  private startGame() {
    const seat = this.cafe.seats.find((s) => s.id === "t2c0");
    if (!seat || !this._model?.vrm) return;
    const cafe = this.cafe;
    let endT = -1;
    const hold: Step = {
      name: "game",
      enter: () => {
        this._base = "game";
        cafe.board.setVisible(true);
        cafe.board.setSession(this._game);
        endT = -1;
      },
      run: (dt) => {
        this._dropT += dt;
        const T = cafe.tables[seat.table];
        const hip = this._hips;
        const restR = new THREE.Vector3(hip.x + (T.x - hip.x) * 0.55, BOARD_TOP_Y + 0.02, hip.z + (T.z - hip.z) * 0.55).addScaledVector(this._left, -0.12);
        const restL = new THREE.Vector3(hip.x + (T.x - hip.x) * 0.6, BOARD_TOP_Y + 0.02, hip.z + (T.z - hip.z) * 0.6).addScaledVector(this._left, 0.17);
        // right hand taps the column when Miko drops a disc
        let r = restR;
        if (this._dropT < 1.1 && this._dropCol >= 0) {
          const top = cafe.board.columnTop(this._dropCol, new THREE.Vector3());
          const u = this._dropT / 1.1;
          r = restR.clone().lerp(top, smooth(u / 0.4) * (1 - smooth((u - 0.6) / 0.4)));
        }
        this.setArms(this.goal(restL, "left"), this.goal(r, "right"));
        this._twistK = 1;

        if (this._game?.status !== "playing" && endT < 0) endT = now();
        if (endT >= 0) {
          const since = now() - endT;
          if (since > 3.2 && cafe.board.isShown) cafe.board.setVisible(false); // board disappears…
          if (since > 4.2) return true; // …then she gets up
        }
        return false;
      },
      exit: () => cafe.board.setVisible(false),
    };
    this.startSteps("game", [...this.standFirst(), this.stepApproach(seat), this.stepSit(seat), hold, this.stepStand(seat)], "wide");
    this._cleanups.push(() => cafe.board.setVisible(false));
  }

  // ───────────────────────── projector clips (!so) ─────────────────────────
  private syncProjector() {
    if (!this._cafe) return;
    this._cafe.projector.setAvailable(projectorStore.available && this._active);
  }

  private onClipRequest(_clip: Clip) {
    if (!this._active || !this._model?.vrm) {
      projectorStore.finishClip();
      return;
    }
    const cafe = this.cafe;
    const sp = cafe.projectorSpot;
    let t0 = 0;
    const present: Step = {
      name: "present",
      enter: () => {
        t0 = now();
        this._base = "screen";
      },
      run: () => {
        const t = now() - t0;
        this._yawGoal = sp.yaw;
        const st = projectorStore.state;
        if (st.phase === "requested") {
          // wait for the screen to be fully down, then roll the clip
          if (cafe.projector.isDown || t > 4) projectorStore.beginPlayback();
          return false;
        }
        if (st.phase !== "playing") return true; // clip over
        // point at the screen for the first moments, then just watch
        if (t < 3.5) {
          const l = this._shoulder.left.distanceTo(cafe.screenPoint);
          const r = this._shoulder.right.distanceTo(cafe.screenPoint);
          const near: "left" | "right" = l < r ? "left" : "right";
          const sh = near === "left" ? this._shoulder.left : this._shoulder.right;
          const dir = cafe.screenPoint.clone().sub(sh).normalize();
          const g = this.goal(sh.clone().addScaledVector(dir, 0.5), near, 0.3);
          this.setArms(near === "left" ? g : null, near === "right" ? g : null);
        }
        return false;
      },
      exit: () => projectorStore.finishClip(),
    };
    this.startSteps(
      "clip",
      [
        ...this.standFirst(),
        this.stepWalk(() => this.planPath({ x: this._pos.x, z: this._pos.y }, { x: sp.x, z: sp.z }), { yaw: sp.yaw, speed: Math.min(this._cfg.walkSpeed, 1.0) }),
        present,
        this.stepWait(0.6),
      ],
      "screen"
    );
    this._cleanups.push(() => projectorStore.finishClip());
  }

  // ───────────────────────── applying the pose ─────────────────────────
  private applyBody(dt: number) {
    const m = this._model;
    const vrm = m?.vrm;
    const cam = this._camera;
    if (!m || !vrm || !cam) return;
    const seatTop = this._seat?.topY ?? 0.5;
    const drop = Math.max(0, m.hipsHeight - (seatTop + SEAT_HIP_ABOVE_SEAT)) * this._sitAmt;
    vrm.scene.position.set(this._pos.x, -drop + (m.walk?.bob ?? 0), this._pos.y);
    vrm.scene.rotation.y = m.baseYaw + this._yaw;
    this.cafe.modelShadow.position.set(this._pos.x, 0.012, this._pos.y);
    this.cafe.modelShadow.visible = this._sitAmt < 0.5;

    const a = m.actions;
    if (!a) return;
    a.sit = this._sitAmt;
    a.sitForward.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    a.setArm("left", this._arms.left);
    a.setArm("right", this._arms.right);

    // seated upper body turns toward the camera (fully while someone is talking to her)
    const toCam = Math.atan2(cam.position.x - this._pos.x, cam.position.z - this._pos.y);
    const k = this._sitAmt > 0.5 ? (this._closeup ? 1 : this._twistK) : 0;
    const goal = clamp(angleDiff(this._yaw, toCam), -1.1, 1.1) * k;
    this._twist += (goal - this._twist) * (1 - Math.exp(-5 * dt));
    a.twist = this._twist;
    a.headPitch += ((this._closeup ? 0 : this._headPitch) - a.headPitch) * (1 - Math.exp(-6 * dt));
  }

  // ───────────────────────── camera ─────────────────────────
  private shotGoal(shot: CafeShot, aspect: number) {
    switch (shot) {
      case "closeup": {
        const h = this._head.lengthSq() > 0 ? this._head : this._t1.set(this._pos.x, 1.4, this._pos.y);
        const dist = CLOSE_DIST / this._cfg.closeupZoom;
        this._goalPos.set(h.x + 0.08, h.y - 0.04, h.z + dist);
        this._goalLook.set(h.x, h.y - 0.16, h.z);
        this._goalFov = CLOSE_FOV;
        break;
      }
      case "follow": {
        // medium shot that trails her (used while serving coffee)
        const y = this._model?.hipsHeight ?? 0.85;
        this._goalLook.set(this._pos.x, y + 0.2, this._pos.y);
        this._goalPos.set(this._pos.x + 0.9, y + 0.75, this._pos.y + 3.0);
        this._goalFov = 40;
        break;
      }
      case "game": {
        const T = this.cafe.tables[2];
        this._goalLook.set(T.x - 0.25, 1.0, T.z);
        this._goalPos.set(T.x - 1.15, 1.55, T.z + 2.75);
        this._goalFov = 36;
        break;
      }
      case "pet": {
        const c = this.cafe.catSpot;
        this._goalLook.set(c.x + 0.3, 0.98, c.z + 0.15);
        this._goalPos.set(c.x + 1.15, 1.3, c.z + 2.4);
        this._goalFov = 32;
        break;
      }
      case "screen": {
        const sp = this.cafe.projectorSpot;
        this._goalLook.set((sp.x - 2.5) / 2 - 0.1, 1.95, -2.6);
        this._goalPos.set(-0.9, 2.15, 3.2);
        this._goalFov = 40;
        break;
      }
      default: {
        // pull back further for narrow windows so the whole room still fits
        const back = Math.min(8, Math.max(0, (1.7 / aspect - 1) * 6));
        const sway = Math.sin(this._time * 0.2) * 0.1;
        this._goalPos.set(this._pos.x * 0.18 + sway, 2.4, 5.0 + back);
        this._goalLook.set(this._pos.x * 0.3, 1.3, -1);
        this._goalFov = 50;
      }
    }
  }

  private updateCamera(dt: number) {
    const cam = this._camera;
    if (!cam) return;
    this.shotGoal(this.shot, cam.aspect || 16 / 9);
    const k = this._snap ? 1 : 1 - Math.exp(-2.6 * dt);
    this._snap = false;
    this._camPos.lerp(this._goalPos, k);
    this._camLook.lerp(this._goalLook, k);
    this._fov += (this._goalFov - this._fov) * k;

    cam.position.copy(this._camPos);
    cam.lookAt(this._camLook);
    if (Math.abs(cam.fov - this._fov) > 0.001) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.cafe.updateGrade(cam);
  }

  /** Tell the projector overlay where the screen is on the canvas (normalised 0..1), or null. */
  private updateProjectorQuad() {
    const cam = this._camera;
    const p = this.cafe.projector;
    const st = projectorStore.state;
    if (!cam || !p.isVisible || !p.isDown || !(st.source || st.phase === "playing")) {
      projectorStore.setQuad(null);
      return;
    }
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const q: { x: number; y: number }[] = [];
    for (const c of p.corners()) {
      const v = this._t1.copy(c).applyMatrix4(cam.matrixWorldInverse);
      if (v.z > -0.05) {
        projectorStore.setQuad(null);
        return;
      }
      const n = this._t2.copy(c).project(cam);
      q.push({ x: (n.x + 1) / 2, y: (1 - n.y) / 2 });
    }
    projectorStore.setQuad(q);
  }

  // ───────────────────────── placement / reset ─────────────────────────
  private placeModel() {
    const vrm = this._model?.vrm;
    if (!vrm || !this._model) return;
    vrm.scene.position.set(this._pos.x, 0, this._pos.y);
    vrm.scene.rotation.y = this._model.baseYaw + this._yaw;
  }

  /** Leaving the cafe (gaming mode / other background): put everything back. */
  private resetAll() {
    this.endActivity(false);
    this._seat = null;
    this._sitAmt = 0;
    this._twist = 0;
    this._speed = 0;
    this._pulls.clear();
    this._tucks = [];
    this._cupTimers = [];
    const c = this._cafe;
    if (c) {
      c.seats.forEach((s) => c.moveChair(s, 0));
      c.serveCups.forEach((s) => s && (s.visible = false));
      c.tray.group.visible = false;
      c.handCup.visible = false;
      c.board.setVisible(false);
      c.hearts.active = false;
    }
    projectorStore.setQuad(null);
    projectorStore.finishClip();
    const m = this._model;
    const vrm = m?.vrm;
    m?.walk?.setSpeed(0);
    if (m?.actions) {
      m.actions.sit = 0;
      m.actions.twist = 0;
      m.actions.headPitch = 0;
      m.actions.setArm("left", null);
      m.actions.setArm("right", null);
    }
    if (vrm && m) {
      vrm.scene.position.set(0, 0, 0);
      vrm.scene.rotation.y = m.baseYaw;
    }
    this._pos.set(0, 0.9);
    this._yaw = 0;
  }
}
