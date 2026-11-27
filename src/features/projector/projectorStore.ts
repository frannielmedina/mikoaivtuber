import { MediaSrc } from "./mediaSource";

// ─────────────────────────────────────────────────────────────────────────────
// ProjectorStore: shared state between settings, Twitch (!so), the CafeDirector
// (who walks Miko to the screen) and the overlay that plays the actual video.
//
//   source   a video / stream from Settings: plays on the screen continuously (muted by default)
//   clip     a one-off clip (!so): Miko walks to the screen, it plays, then she walks off
//
// The screen only exists in the cafe while `available` is true: a source is set,
// or Twitch is connected and there are clips to show.
// ─────────────────────────────────────────────────────────────────────────────

export type Clip = { id: string; media: MediaSrc; title?: string; by?: string; duration?: number };
export type ClipPhase = "idle" | "requested" | "playing";
export type Quad = { x: number; y: number }[]; // normalised 0..1 (TL, TR, BR, BL)

type State = {
  source: MediaSrc | null;
  sourceKey: string;
  hasClips: boolean;
  twitchConnected: boolean;
  clip: Clip | null;
  phase: ClipPhase;
  maxClipSeconds: number;
};

class ProjectorStore {
  private s: State = { source: null, sourceKey: "", hasClips: false, twitchConnected: false, clip: null, phase: "idle", maxClipSeconds: 45 };
  private listeners = new Set<() => void>();
  private requestListeners = new Set<(c: Clip) => void>();
  private quadListeners = new Set<(q: Quad | null) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  get state() {
    return this.s;
  }
  get available() {
    return !!this.s.source || (this.s.twitchConnected && this.s.hasClips);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  onRequest(fn: (c: Clip) => void): () => void {
    this.requestListeners.add(fn);
    return () => void this.requestListeners.delete(fn);
  }
  onQuad(fn: (q: Quad | null) => void): () => void {
    this.quadListeners.add(fn);
    return () => void this.quadListeners.delete(fn);
  }
  /** Called every frame by the director with where the screen is on the canvas (null = not visible). */
  setQuad(q: Quad | null) {
    this.quadListeners.forEach((l) => l(q));
  }

  private set(p: Partial<State>) {
    this.s = { ...this.s, ...p };
    this.listeners.forEach((l) => l());
  }

  setSource(src: MediaSrc | null) {
    const key = src ? `${src.kind}:${src.src}` : "";
    if (key === this.s.sourceKey) return;
    this.set({ source: src, sourceKey: key });
  }
  setClipAvailability(hasClips: boolean, twitchConnected: boolean) {
    if (hasClips === this.s.hasClips && twitchConnected === this.s.twitchConnected) return;
    this.set({ hasClips, twitchConnected });
  }
  setMaxClipSeconds(n: number) {
    this.s.maxClipSeconds = n;
  }

  /** Ask for a clip to be shown. Miko walks to the screen first; false if one is already queued/playing. */
  requestClip(clip: Clip): boolean {
    if (this.s.phase !== "idle" || !this.available) return false;
    this.set({ clip, phase: "requested" });
    this.requestListeners.forEach((l) => l(clip));
    return true;
  }

  /** The director calls this once she is at the screen and it is rolled down. */
  beginPlayback() {
    if (this.s.phase !== "requested") return;
    this.set({ phase: "playing" });
    const secs = (this.s.clip?.duration ? this.s.clip.duration + 2 : this.s.maxClipSeconds) + 1;
    this.timer = setTimeout(() => this.finishClip(), Math.min(secs, this.s.maxClipSeconds + 3) * 1000);
  }

  /** Clip over (video ended, or the safety timer ran out). */
  finishClip() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.s.phase === "idle") return;
    this.set({ phase: "idle", clip: null });
  }
}

export const projectorStore = new ProjectorStore();

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") (window as any).__projectorStore = projectorStore;
