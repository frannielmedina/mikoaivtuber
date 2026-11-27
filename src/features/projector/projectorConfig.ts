export type ProjectorConfig = {
  /** A video file URL, YouTube / Twitch / VDO.Ninja link or .m3u8 stream shown on the screen all the time. */
  source: string;
  sourceAudio: boolean;
  /** Use the broadcaster's own Twitch clips for !so (needs Client ID + token, same as alerts). */
  useChannelClips: boolean;
  /** Extra clip / video URLs for !so, one per line. */
  clipList: string;
  /** Anyone in chat can use !so (default: mods + broadcaster only). */
  everyoneCanShoutout: boolean;
  /** Safety cut-off when a clip's length is unknown. */
  maxClipSeconds: number;
};

export const DEFAULT_PROJECTOR_CONFIG: ProjectorConfig = {
  source: "",
  sourceAudio: false,
  useChannelClips: true,
  clipList: "",
  everyoneCanShoutout: false,
  maxClipSeconds: 45,
};

export function sanitizeProjectorConfig(c: Partial<ProjectorConfig> | undefined): ProjectorConfig {
  const m = { ...DEFAULT_PROJECTOR_CONFIG, ...(c ?? {}) };
  const src = String(m.source ?? "").trim();
  return {
    // blob: URLs (picked local files) die with the page, so they are never restored from storage
    source: src.startsWith("blob:") ? "" : src,
    sourceAudio: !!m.sourceAudio,
    useChannelClips: m.useChannelClips !== false,
    clipList: String(m.clipList ?? ""),
    everyoneCanShoutout: !!m.everyoneCanShoutout,
    maxClipSeconds: Math.min(120, Math.max(10, Number(m.maxClipSeconds) || 45)),
  };
}
