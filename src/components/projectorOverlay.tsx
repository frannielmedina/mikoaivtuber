import { useEffect, useRef, useState } from "react";
import { projectorStore } from "@/features/projector/projectorStore";
import { MediaSrc } from "@/features/projector/mediaSource";
import { quadToMatrix3d } from "@/features/projector/homography";

// The video / stream / clip shown on the cafe's projector screen.
//
// The 3D scene only draws a blank screen; the real content is a DOM element (so it can be a
// Twitch / YouTube / VDO.Ninja embed, which can't be a WebGL texture) that is pinned onto the
// screen every frame with a CSS perspective transform computed from the screen's 4 corners
// as seen by the 3D camera. Nothing is shown unless the director reports the screen as
// visible, so it disappears with the cafe (gaming mode, other backgrounds).

const BASE_W = 1280;
const BASE_H = 720;

const Video = ({ media, muted, loop, onEnded }: { media: MediaSrc; muted: boolean; loop: boolean; onEnded?: () => void }) => {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    const start = () => v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });

    if (media.kind === "hls" && !v.canPlayType("application/vnd.apple.mpegurl")) {
      import("hls.js").then(({ default: Hls }) => {
        if (cancelled) return;
        if (Hls.isSupported()) {
          const h = new Hls();
          h.loadSource(media.src);
          h.attachMedia(v);
          hls = h;
          start();
        }
      });
    } else {
      v.src = media.src;
      start();
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [media.src, media.kind]);

  return (
    <video
      ref={ref}
      muted={muted}
      loop={loop}
      playsInline
      crossOrigin="anonymous"
      onEnded={onEnded}
      style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
    />
  );
};

export const ProjectorOverlay = ({ sourceAudio }: { sourceAudio: boolean }) => {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);

  useEffect(() => projectorStore.subscribe(() => bump((n) => n + 1)), []);

  // Pin the surface onto the 3D screen (no React re-render per frame).
  useEffect(
    () =>
      projectorStore.onQuad((q) => {
        const h = host.current;
        const s = surface.current;
        if (!h || !s) return;
        if (!q) {
          s.style.display = "none";
          return;
        }
        const W = h.clientWidth;
        const H = h.clientHeight;
        s.style.display = "block";
        s.style.transform = quadToMatrix3d(BASE_W, BASE_H, q.map((p) => ({ x: p.x * W, y: p.y * H })));
      }),
    []
  );

  const st = projectorStore.state;
  const isClip = st.phase === "playing" && !!st.clip;
  const media = isClip ? st.clip!.media : st.source;

  return (
    <div ref={host} style={{ position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none", overflow: "hidden" }}>
      <div
        ref={surface}
        style={{ position: "absolute", left: 0, top: 0, width: BASE_W, height: BASE_H, transformOrigin: "0 0", display: "none", background: "#000", overflow: "hidden" }}
      >
        {media &&
          (media.kind === "iframe" ? (
            <iframe
              key={`${isClip ? "clip" : "source"}:${media.src}`}
              src={media.src}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
              style={{ width: "100%", height: "100%", border: 0 }}
            />
          ) : (
            <Video
              key={`${isClip ? "clip" : "source"}:${media.src}`}
              media={media}
              muted={isClip ? false : !sourceAudio}
              loop={!isClip}
              onEnded={isClip ? () => projectorStore.finishClip() : undefined}
            />
          ))}
      </div>
    </div>
  );
};
