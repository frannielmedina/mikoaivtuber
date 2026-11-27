import { CSSProperties, useEffect, useState } from "react";
import { gameManager, Connect4Session } from "@/features/games/gameManager";
import { COLS, ROWS } from "@/features/games/connect4";
import { GameCorner, GamesConfig, GAME_COMMANDS } from "@/features/games/gamesConfig";

// Palette comes from the app itself (tailwind.config.js): wisteria board,
// strawberry for chat's discs, butter yellow for Miko's, cocoa text on cream.
const BOARD = "#856292";
const BOARD_DARK = "#6f4f7c";
const CHAT = "#FF617F";
const MIKO = "#FFD66B";
const CREAM = "#FBE2CA";
const COCOA = "#514062";

const CELL = 38;
const GAP = 4;
const PAD = 10;

type Props = {
  config: GamesConfig;
  /** Command hints are only shown while Twitch chat is connected. */
  twitchConnected: boolean;
  /** Where to put it (already adjusted so it never sits under the screen-share facecam). */
  corner: GameCorner;
  /** The cafe is showing the 3D board on the table, so only the status/buttons are drawn here. */
  cafe3D?: boolean;
};

function cornerStyle(corner: GameCorner): CSSProperties {
  const m = 24;
  return {
    position: "absolute",
    zIndex: 20,
    ...(corner.startsWith("top") ? { top: m } : { bottom: m }),
    ...(corner.endsWith("left") ? { left: m } : { right: m }),
  };
}

const CommandCard = ({ compact }: { compact?: boolean }) => (
  <div
    style={{
      background: CREAM,
      color: COCOA,
      borderRadius: 14,
      padding: compact ? "8px 12px" : "12px 16px",
      boxShadow: "0 6px 20px rgba(81,64,98,0.28)",
      border: `2px solid ${BOARD}`,
      fontSize: 13,
      lineHeight: 1.35,
    }}
  >
    {!compact && <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>Play Connect 4 with Miko</div>}
    {GAME_COMMANDS.map((c) => (
      <div key={c.cmd} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <code
          style={{
            background: BOARD,
            color: "#fff",
            borderRadius: 6,
            padding: "1px 7px",
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          {c.cmd}
        </code>
        <span>{c.text}</span>
      </div>
    ))}
  </div>
);

const Disc = ({ who, drop, win }: { who: 0 | 1 | 2; drop?: number; win?: boolean }) => (
  <div
    style={{
      width: CELL,
      height: CELL,
      borderRadius: "50%",
      background: who === 0 ? CREAM : who === 1 ? CHAT : MIKO,
      boxShadow:
        who === 0
          ? `inset 0 3px 5px rgba(81,64,98,0.35)`
          : `inset 0 -4px 0 rgba(0,0,0,0.14), inset 0 3px 0 rgba(255,255,255,0.35)`,
      animation: drop !== undefined ? `c4drop 0.55s cubic-bezier(.3,.7,.4,1) both` : win ? "c4win 0.9s ease-in-out infinite" : undefined,
      ["--from" as any]: drop !== undefined ? `${-(drop + 1) * (CELL + GAP) - 20}px` : undefined,
    }}
  />
);

const Board = ({ s, hideGrid }: { s: Connect4Session; hideGrid?: boolean }) => {
  const win = new Set((s.winLine ?? []).map(([r, c]) => `${r}:${c}`));
  const playing = s.status === "playing" && s.turn === 1 && !s.thinking;
  return (
    <div>
      {/* Column numbers double as buttons so the streamer can click to play */}
      <div style={{ display: "flex", gap: GAP, padding: `0 ${PAD}px`, marginBottom: 4 }}>
        {Array.from({ length: COLS }, (_, c) => (
          <button
            key={c}
            disabled={!playing}
            onClick={() => gameManager.humanMove(c, "You", true, true)}
            title={playing ? `Drop in column ${c + 1}` : undefined}
            style={{
              width: CELL,
              height: 22,
              borderRadius: 8,
              border: "none",
              background: playing ? BOARD : "rgba(133,98,146,0.35)",
              color: "#fff",
              fontWeight: 800,
              fontSize: 13,
              cursor: playing ? "pointer" : "default",
              pointerEvents: "auto",
            }}
          >
            {c + 1}
          </button>
        ))}
      </div>
      {!hideGrid && (
      <div
        style={{
          background: `linear-gradient(${BOARD}, ${BOARD_DARK})`,
          borderRadius: 14,
          padding: PAD,
          display: "grid",
          gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
          gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`,
          gap: GAP,
          boxShadow: "inset 0 0 0 3px rgba(255,255,255,0.12)",
        }}
      >
        {s.board.flatMap((row, r) =>
          row.map((cell, c) => {
            const isLast = s.lastMove && s.lastMove.row === r && s.lastMove.col === c;
            return (
              <Disc
                key={`${r}:${c}:${cell}:${isLast ? s.moves : 0}`}
                who={cell}
                drop={isLast && cell !== 0 ? r : undefined}
                win={win.has(`${r}:${c}`)}
              />
            );
          })
        )}
      </div>
      )}
    </div>
  );
};

export const GamesOverlay = ({ config, twitchConnected, corner, cafe3D }: Props) => {
  const [session, setSession] = useState<Connect4Session | null>(null);
  useEffect(() => gameManager.subscribe(setSession), []);

  if (!config.enabled) return null;
  if (!session && !twitchConnected) return null;

  const turnLabel = session?.status === "playing" ? (session.turn === 1 ? "Chat's turn" : "Miko's turn") : null;

  return (
    <div style={{ ...cornerStyle(corner), pointerEvents: "none", width: "max-content", maxWidth: 360 }}>
      <style>{`
        @keyframes c4drop { from { transform: translateY(var(--from)); } 60% { transform: translateY(0); } 78% { transform: translateY(-9px); } 100% { transform: translateY(0); } }
        @keyframes c4win { 0%,100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,255,255,0.9); } 50% { transform: scale(1.12); box-shadow: 0 0 0 5px rgba(255,255,255,0.0), 0 0 14px 4px rgba(255,255,255,0.95); } }
      `}</style>

      {session ? (
        <div
          style={{
            background: CREAM,
            color: COCOA,
            borderRadius: 18,
            padding: 12,
            boxShadow: "0 8px 26px rgba(81,64,98,0.35)",
            border: `2px solid ${BOARD}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "0 2px" }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Connect 4</div>
            <div style={{ display: "flex", gap: 10, fontSize: 12, fontWeight: 700, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <i style={{ width: 11, height: 11, borderRadius: "50%", background: CHAT, display: "inline-block" }} />
                {session.starter === "You" || config.whoCanPlay === "everyone" ? "Chat" : session.starter}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <i style={{ width: 11, height: 11, borderRadius: "50%", background: MIKO, display: "inline-block" }} />
                Miko
              </span>
            </div>
          </div>

          <Board s={session} hideGrid={cafe3D} />

          <div
            style={{
              marginTop: 8,
              padding: "6px 10px",
              borderRadius: 10,
              background:
                session.status === "won" ? (session.winner === 1 ? CHAT : MIKO) : "rgba(133,98,146,0.14)",
              color: session.status === "won" && session.winner === 2 ? COCOA : session.status === "won" ? "#fff" : COCOA,
              fontSize: 13,
              fontWeight: 700,
              textAlign: "center",
              minHeight: 20,
            }}
          >
            {turnLabel && (
              <i
                title={turnLabel}
                style={{
                  display: "inline-block", width: 11, height: 11, borderRadius: "50%", marginRight: 8,
                  verticalAlign: "-1px", background: session.turn === 1 ? CHAT : MIKO,
                }}
              />
            )}
            {session.message}
          </div>

          {twitchConnected && session.status === "playing" && (
            <div style={{ marginTop: 8 }}>
              <CommandCard compact />
            </div>
          )}
        </div>
      ) : (
        <CommandCard />
      )}
    </div>
  );
};
