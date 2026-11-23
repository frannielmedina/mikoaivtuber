import type { TwitchMessage } from "@/features/twitch/twitchClient";
import {
  Board, COLS, Player, Pos, chooseMove, dropDisc, emptyBoard, findWin, isFull,
} from "./connect4";
import { DEFAULT_GAMES_CONFIG, GamesConfig } from "./gamesConfig";

// ─────────────────────────────────────────────────────────────────────────────
// GameManager: one shared store for the running game. It is plain TypeScript
// (no React), so Twitch chat, the local text box and the on-screen board can all
// drive the same game. Twitch IRC here is read-only (anonymous login), so all
// feedback is shown on screen rather than sent back to chat.
//
//   !c4           start a game (chat = pink discs, Miko = yellow)
//   !c4 <1-7>     drop a disc in that column
//   !c4 stop      end the game (mods / broadcaster / the local streamer)
//
// To add another game later: add its rules next to connect4.ts, add a session type
// here and a view in components/gamesOverlay.tsx — the command plumbing is shared.
// ─────────────────────────────────────────────────────────────────────────────

export type Connect4Session = {
  game: "connect4";
  board: Board;
  turn: Player; // 1 = chat, 2 = Miko
  status: "playing" | "won" | "draw" | "stopped";
  winner?: Player;
  winLine?: Pos[];
  lastMove?: { row: number; col: number; who: Player };
  starter: string;
  message: string;
  thinking: boolean;
  moves: number;
  updatedAt: number;
};

export type GameEvent =
  | { type: "started"; by: string }
  | { type: "chatWon" }
  | { type: "mikoWon" }
  | { type: "draw" };

type Listener = (s: Connect4Session | null) => void;

const LOCAL = "You";
const MOVE_COOLDOWN_MS = 400; // a single viewer can't flood the board

class GameManager {
  private cfg: GamesConfig = DEFAULT_GAMES_CONFIG;
  private session: Connect4Session | null = null;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: GameEvent) => void>();
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastMoveBy = new Map<string, number>();

  // ── store ──────────────────────────────────────────────────────────────────
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.session);
    return () => this.listeners.delete(fn);
  }
  onEvent(fn: (e: GameEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  getSession() {
    return this.session;
  }
  setConfig(cfg: GamesConfig) {
    this.cfg = cfg;
    if (!cfg.enabled && this.session) this.clear();
  }
  get config() {
    return this.cfg;
  }

  private emit() {
    this.listeners.forEach((l) => l(this.session ? { ...this.session } : null));
  }
  private fire(e: GameEvent) {
    if (this.cfg.aiCommentary) this.eventListeners.forEach((l) => l(e));
  }
  private patch(p: Partial<Connect4Session>) {
    if (!this.session) return;
    this.session = { ...this.session, ...p, updatedAt: Date.now() };
    this.emit();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(by: string = LOCAL): boolean {
    if (!this.cfg.enabled) return false;
    if (this.session?.status === "playing") return false;
    this.clearTimers();
    this.session = {
      game: "connect4",
      board: emptyBoard(),
      turn: 1,
      status: "playing",
      starter: by,
      message: this.cfg.whoCanPlay === "starter" ? `${by} vs Miko — ${by} goes first` : "Chat vs Miko — chat goes first",
      thinking: false,
      moves: 0,
      updatedAt: Date.now(),
    };
    this.lastMoveBy.clear();
    this.idleTimer = setInterval(() => {
      const s = this.session;
      if (s?.status === "playing" && Date.now() - s.updatedAt > this.cfg.idleTimeoutSeconds * 1000) {
        this.stop("no activity");
      }
    }, 5000);
    this.emit();
    this.fire({ type: "started", by });
    return true;
  }

  stop(why = "ended"): void {
    if (!this.session || this.session.status !== "playing") return;
    this.clearTimers(false);
    this.patch({ status: "stopped", thinking: false, message: `Game ${why}` });
    this.scheduleClear();
  }

  /** Remove the board from the screen right away. */
  clear() {
    this.clearTimers();
    this.session = null;
    this.emit();
  }

  private clearTimers(includeEnd = true) {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (includeEnd && this.endTimer) clearTimeout(this.endTimer);
    this.aiTimer = this.idleTimer = null;
    if (includeEnd) this.endTimer = null;
  }

  private scheduleClear() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.clear(), this.cfg.endScreenSeconds * 1000);
  }

  // ── moves ──────────────────────────────────────────────────────────────────
  /** `col` is 0-based. `local` = the streamer clicking the board / typing in the text box. */
  humanMove(col: number, by: string, local = false, isMod = false): boolean {
    const s = this.session;
    if (!s || s.status !== "playing" || s.turn !== 1 || s.thinking) return false;
    if (col < 0 || col >= COLS) return false;

    if (!local && this.cfg.whoCanPlay === "starter" && !isMod && by.toLowerCase() !== s.starter.toLowerCase()) {
      return false;
    }
    const now = Date.now();
    if (now - (this.lastMoveBy.get(by) ?? 0) < MOVE_COOLDOWN_MS) return false;
    this.lastMoveBy.set(by, now);

    const board = s.board.map((r) => r.slice()) as Board;
    const row = dropDisc(board, col, 1);
    if (row < 0) {
      this.patch({ message: `Column ${col + 1} is full — pick another` });
      return false;
    }
    this.afterMove(board, row, col, 1, `${by} dropped in column ${col + 1}`);
    return true;
  }

  private afterMove(board: Board, row: number, col: number, who: Player, msg: string) {
    const win = findWin(board);
    const moves = (this.session?.moves ?? 0) + 1;
    const lastMove = { row, col, who };

    if (win) {
      this.clearTimers(false);
      this.patch({
        board, lastMove, moves, thinking: false, status: "won", winner: win.who, winLine: win.line,
        message: win.who === 1 ? "Chat wins! 🎉" : "Miko wins! 🐱",
      });
      this.scheduleClear();
      this.fire({ type: win.who === 1 ? "chatWon" : "mikoWon" });
      return;
    }
    if (isFull(board)) {
      this.clearTimers(false);
      this.patch({ board, lastMove, moves, thinking: false, status: "draw", message: "It's a draw!" });
      this.scheduleClear();
      this.fire({ type: "draw" });
      return;
    }

    if (who === 1) {
      this.patch({ board, lastMove, moves, turn: 2, thinking: true, message: `${msg} — Miko is thinking…` });
      this.aiTimer = setTimeout(() => this.mikoMove(), 800 + Math.random() * 700);
    } else {
      this.patch({ board, lastMove, moves, turn: 1, thinking: false, message: `${msg} — your move, chat!` });
    }
  }

  private mikoMove() {
    const s = this.session;
    if (!s || s.status !== "playing" || s.turn !== 2) return;
    const col = chooseMove(s.board, 2, this.cfg.difficulty);
    if (col < 0) return;
    const board = s.board.map((r) => r.slice()) as Board;
    const row = dropDisc(board, col, 2);
    this.afterMove(board, row, col, 2, `Miko dropped in column ${col + 1}`);
  }

  // ── input: Twitch chat + local text box ────────────────────────────────────
  /** Returns true if the message was a game command (so callers can skip it). */
  handleChat(msg: TwitchMessage): boolean {
    return this.handleText(msg.message, msg.username, false, !!(msg.isMod || msg.isBroadcaster));
  }

  handleLocalText(text: string): boolean {
    return this.handleText(text, LOCAL, true, true);
  }

  private handleText(text: string, by: string, local: boolean, isMod: boolean): boolean {
    const m = text.trim().match(/^!(?:c4|connect4)(?:\s+(\S+))?/i);
    if (!m) return false;
    if (!this.cfg.enabled) return true;
    const arg = (m[1] ?? "").toLowerCase();

    if (!arg) {
      if (!this.start(by) && this.session?.status === "playing") {
        this.patch({ message: "A game is already running — type !c4 and a column 1-7" });
      }
      return true;
    }
    if (arg === "stop" || arg === "end") {
      if (isMod) this.stop("stopped by " + by);
      return true;
    }
    const n = parseInt(arg, 10);
    if (Number.isInteger(n) && n >= 1 && n <= COLS) this.humanMove(n - 1, by, local, isMod);
    return true;
  }
}

export const gameManager = new GameManager();
