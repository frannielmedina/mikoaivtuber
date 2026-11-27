import { Clip } from "./projectorStore";
import { resolveMedia } from "./mediaSource";

// Where `!so` gets its clips from: the broadcaster's (or a named channel's) own clips via
// Twitch Helix — using the same Client ID + token already used for alerts — plus any
// clip/video URLs pasted into Settings.

const HELIX = "https://api.twitch.tv/helix";
const cleanToken = (t: string) => t.replace(/^oauth:/i, "").trim();

async function helix(path: string, clientId: string, token: string) {
  const res = await fetch(`${HELIX}${path}`, {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${cleanToken(token)}` },
  });
  if (!res.ok) throw new Error(`Helix ${res.status}`);
  return res.json();
}

function toClip(c: any): Clip | null {
  if (!c?.id) return null;
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return {
    id: c.id,
    media: { kind: "iframe", src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.id)}&parent=${host}&autoplay=true&muted=false` },
    title: c.title,
    by: c.broadcaster_name,
    duration: typeof c.duration === "number" ? c.duration : undefined,
  };
}

export async function fetchChannelClips(clientId: string, token: string, broadcasterId: string): Promise<Clip[]> {
  try {
    const data = await helix(`/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=100`, clientId, token);
    return (data?.data ?? []).map(toClip).filter(Boolean) as Clip[];
  } catch (e) {
    console.warn("[Projector] could not fetch clips", e);
    return [];
  }
}

export async function fetchClipsForLogin(clientId: string, token: string, login: string): Promise<Clip[]> {
  try {
    const u = await helix(`/users?login=${encodeURIComponent(login.toLowerCase())}`, clientId, token);
    const id = u?.data?.[0]?.id;
    return id ? fetchChannelClips(clientId, token, id) : [];
  } catch (e) {
    console.warn("[Projector] could not look up channel", e);
    return [];
  }
}

/** Clips pasted in Settings (one URL per line). */
export function parseManualClips(text: string): Clip[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((url, i) => {
      const media = resolveMedia(url, true);
      return media ? ({ id: `manual-${i}`, media, title: url } as Clip) : null;
    })
    .filter(Boolean) as Clip[];
}

export function pickRandom<T>(list: T[]): T | null {
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}
