// ── Connect 4 rules + AI opponent (no UI, no Twitch — pure logic) ────────────
export const ROWS = 6;
export const COLS = 7;

/** 0 = empty, 1 = chat / the human side, 2 = Miko. */
export type Cell = 0 | 1 | 2;
export type Player = 1 | 2;
/** board[row][col], row 0 is the TOP row. */
export type Board = Cell[][];
export type Pos = [row: number, col: number];

export type Difficulty = "easy" | "normal" | "hard";

export function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(0));
}

export function cloneBoard(b: Board): Board {
  return b.map((r) => r.slice()) as Board;
}

export function legalCols(b: Board): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (b[0][c] === 0) out.push(c);
  return out;
}

/** Drops a disc; returns the row it landed in, or -1 if the column is full. */
export function dropDisc(b: Board, col: number, who: Player): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (b[r][col] === 0) {
      b[r][col] = who;
      return r;
    }
  }
  return -1;
}

const DIRS: Pos[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** First four-in-a-row found, or null. */
export function findWin(b: Board): { who: Player; line: Pos[] } | null {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const who = b[r][c];
      if (!who) continue;
      for (const [dr, dc] of DIRS) {
        const line: Pos[] = [[r, c]];
        for (let k = 1; k < 4; k++) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || b[rr][cc] !== who) break;
          line.push([rr, cc]);
        }
        if (line.length === 4) return { who, line };
      }
    }
  }
  return null;
}

export function isFull(b: Board): boolean {
  return b[0].every((c) => c !== 0);
}

// ── AI ───────────────────────────────────────────────────────────────────────
const ORDER = [3, 2, 4, 1, 5, 0, 6]; // centre first = better pruning + better play

function evaluate(b: Board, me: Player): number {
  const opp: Player = me === 1 ? 2 : 1;
  let s = 0;
  for (let r = 0; r < ROWS; r++) if (b[r][3] === me) s += 3;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of DIRS) {
        const er = r + dr * 3;
        const ec = c + dc * 3;
        if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = b[r + dr * k][c + dc * k];
          if (v === me) mine++;
          else if (v === opp) theirs++;
        }
        if (mine && theirs) continue;
        if (mine === 3) s += 5;
        else if (mine === 2) s += 2;
        if (theirs === 3) s -= 6;
        else if (theirs === 2) s -= 2;
      }
    }
  }
  return s;
}

/** Negamax with alpha-beta; score is from the point of view of `toMove`. */
function negamax(b: Board, depth: number, alpha: number, beta: number, toMove: Player, me: Player): number {
  const w = findWin(b);
  if (w) return (w.who === toMove ? 1 : -1) * (100000 + depth);
  if (isFull(b)) return 0;
  if (depth === 0) return (toMove === me ? 1 : -1) * evaluate(b, me);

  const next: Player = toMove === 1 ? 2 : 1;
  let best = -Infinity;
  for (const c of ORDER) {
    if (b[0][c] !== 0) continue;
    const r = dropDisc(b, c, toMove);
    const v = -negamax(b, depth - 1, -beta, -alpha, next, me);
    b[r][c] = 0; // undo
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

const DEPTH: Record<Difficulty, number> = { easy: 2, normal: 4, hard: 6 };

/** Picks a column for `me`. Easy sometimes blunders on purpose so chat can win. */
export function chooseMove(board: Board, me: Player, difficulty: Difficulty): number {
  const legal = legalCols(board);
  if (legal.length === 0) return -1;
  const opp: Player = me === 1 ? 2 : 1;
  const b = cloneBoard(board);

  // Always take a win / block a loss in one, whatever the difficulty (a "random" Miko that
  // ignores an obvious four-in-a-row just looks broken).
  for (const who of [me, opp] as Player[]) {
    for (const c of legal) {
      const r = dropDisc(b, c, who);
      const won = findWin(b)?.who === who;
      b[r][c] = 0;
      if (won && (who === me || difficulty !== "easy" || Math.random() < 0.7)) return c;
    }
  }
  if (difficulty === "easy" && Math.random() < 0.3) return legal[Math.floor(Math.random() * legal.length)];

  let bestCol = legal[0];
  let bestScore = -Infinity;
  for (const c of ORDER) {
    if (b[0][c] !== 0) continue;
    const r = dropDisc(b, c, me);
    const v = -negamax(b, DEPTH[difficulty] - 1, -Infinity, Infinity, opp, me) + Math.random() * 0.01;
    b[r][c] = 0;
    if (v > bestScore) {
      bestScore = v;
      bestCol = c;
    }
  }
  return bestCol;
}
