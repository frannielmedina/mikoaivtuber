// Turns whatever URL the streamer pastes into something the projector can show.
//   direct video file (.mp4 .webm …, blob:)  → <video>
//   .m3u8 (HLS stream)                       → <video> via hls.js
//   Twitch clip / channel / VOD              → Twitch embed iframe
//   YouTube video / live / shorts            → YouTube embed iframe
//   anything else (VDO.Ninja, a player page) → iframe as-is
export type MediaSrc = { kind: "iframe" | "video" | "hls"; src: string };

export function resolveMedia(raw: string, audio: boolean): MediaSrc | null {
  const input = (raw ?? "").trim();
  if (!input) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const pathq = u.pathname + u.search;
  const muted = audio ? "false" : "true";

  if (u.protocol === "blob:" || /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i.test(pathq)) return { kind: "video", src: input };
  if (/\.m3u8(\?|#|$)/i.test(pathq)) return { kind: "hls", src: input };

  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    const id =
      host === "youtu.be"
        ? u.pathname.slice(1)
        : u.searchParams.get("v") || u.pathname.match(/\/(?:live|shorts|embed)\/([\w-]{6,})/)?.[1] || "";
    if (id) {
      const mute = audio ? 0 : 1;
      return {
        kind: "iframe",
        src: `https://www.youtube.com/embed/${id}?autoplay=1&mute=${mute}&controls=0&rel=0&playsinline=1&loop=1&playlist=${id}`,
      };
    }
  }

  if (host === "clips.twitch.tv" || host === "twitch.tv") {
    const clip = host === "clips.twitch.tv" ? u.searchParams.get("clip") || u.pathname.slice(1) : u.pathname.match(/\/clip\/([\w-]+)/)?.[1];
    if (clip) return { kind: "iframe", src: `https://clips.twitch.tv/embed?clip=${clip}&parent=${parent}&autoplay=true&muted=${muted}` };
    const vod = u.pathname.match(/^\/videos\/(\d+)/)?.[1];
    if (vod) return { kind: "iframe", src: `https://player.twitch.tv/?video=v${vod}&parent=${parent}&autoplay=true&muted=${muted}` };
    const ch = u.pathname.match(/^\/([A-Za-z0-9_]{2,25})\/?$/)?.[1];
    if (ch) return { kind: "iframe", src: `https://player.twitch.tv/?channel=${ch}&parent=${parent}&autoplay=true&muted=${muted}` };
  }

  return { kind: "iframe", src: input };
}
