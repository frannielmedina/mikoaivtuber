import { Difficulty } from "./connect4";

export type GameCorner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export type GamesConfig = {
  enabled: boolean;
  difficulty: Difficulty;
  /** "everyone": any viewer can drop discs for the human side. "starter": only whoever typed !c4. */
  whoCanPlay: "everyone" | "starter";
  corner: GameCorner;
  /** Miko comments on the game (start / win / loss) through the AI. */
  aiCommentary: boolean;
  /** How long the final board stays on screen after a game ends. */
  endScreenSeconds: number;
  /** A game with no moves for this long is dropped. */
  idleTimeoutSeconds: number;
};

export const DEFAULT_GAMES_CONFIG: GamesConfig = {
  enabled: true,
  difficulty: "normal",
  whoCanPlay: "everyone",
  corner: "bottom-left",
  aiCommentary: true,
  endScreenSeconds: 15,
  idleTimeoutSeconds: 180,
};

export function sanitizeGamesConfig(c: Partial<GamesConfig> | undefined): GamesConfig {
  const m = { ...DEFAULT_GAMES_CONFIG, ...(c ?? {}) };
  const clamp = (v: number, a: number, b: number, d: number) => Math.min(b, Math.max(a, Number(v) || d));
  return {
    enabled: !!m.enabled,
    difficulty: (["easy", "normal", "hard"] as const).includes(m.difficulty) ? m.difficulty : "normal",
    whoCanPlay: m.whoCanPlay === "starter" ? "starter" : "everyone",
    corner: (["bottom-left", "bottom-right", "top-left", "top-right"] as const).includes(m.corner) ? m.corner : "bottom-left",
    aiCommentary: !!m.aiCommentary,
    endScreenSeconds: clamp(m.endScreenSeconds, 3, 120, 15),
    idleTimeoutSeconds: clamp(m.idleTimeoutSeconds, 30, 1800, 180),
  };
}

/** Chat commands, shown on screen in the corner while Twitch is connected. */
export const GAME_COMMANDS = [
  { cmd: "!c4", text: "start Connect 4" },
  { cmd: "!c4 1-7", text: "drop a disc in that column" },
];
