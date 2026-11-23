// Settings for the 3D anime cafe: the walkable scene that replaces the old
// flat jpg/png background (Settings → Background → "Anime Cafe").

export type TimeOfDay = "day" | "sunset" | "night";

export type CafeConfig = {
  timeOfDay: TimeOfDay;
  /** Miko strolls around the cafe while nobody is talking to her. */
  wander: boolean;
  /** Walking speed in metres per second. */
  walkSpeed: number;
  /**
   * How long (seconds) the AI has to stay idle — not thinking, not speaking —
   * before the camera zooms back out of the close-up.
   */
  closeupHoldSeconds: number;
  /** 1 = default close-up, >1 = tighter, <1 = looser. */
  closeupZoom: number;
};

export const DEFAULT_CAFE_CONFIG: CafeConfig = {
  timeOfDay: "day",
  wander: true,
  walkSpeed: 0.8,
  closeupHoldSeconds: 10,
  closeupZoom: 1,
};

export const TIME_OF_DAY_OPTIONS: { id: TimeOfDay; label: string; emoji: string }[] = [
  { id: "day", label: "Day", emoji: "☀️" },
  { id: "sunset", label: "Sunset", emoji: "🌇" },
  { id: "night", label: "Night", emoji: "🌙" },
];

export function sanitizeCafeConfig(c: Partial<CafeConfig> | undefined): CafeConfig {
  const m = { ...DEFAULT_CAFE_CONFIG, ...(c ?? {}) };
  return {
    timeOfDay: (["day", "sunset", "night"] as const).includes(m.timeOfDay) ? m.timeOfDay : "day",
    wander: !!m.wander,
    walkSpeed: clamp(Number(m.walkSpeed) || DEFAULT_CAFE_CONFIG.walkSpeed, 0.3, 1.6),
    closeupHoldSeconds: clamp(Number(m.closeupHoldSeconds) || DEFAULT_CAFE_CONFIG.closeupHoldSeconds, 2, 120),
    closeupZoom: clamp(Number(m.closeupZoom) || 1, 0.6, 1.8),
  };
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}
