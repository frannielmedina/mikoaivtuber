import React, { useEffect, useState } from "react";
import { CafeConfig, TIME_OF_DAY_OPTIONS } from "@/features/cafe/cafeConfig";
import { GameCorner, GamesConfig, GAME_COMMANDS } from "@/features/games/gamesConfig";
import { Difficulty } from "@/features/games/connect4";
import { gameManager, Connect4Session } from "@/features/games/gameManager";
import { BackgroundConfig } from "@/features/background/backgroundConfig";

type Props = {
  cafeConfig: CafeConfig;
  onChangeCafeConfig: (c: CafeConfig) => void;
  gamesConfig: GamesConfig;
  onChangeGamesConfig: (c: GamesConfig) => void;
  backgroundConfig: BackgroundConfig;
  onChangeBackgroundConfig: (c: BackgroundConfig) => void;
};

const Slider = ({
  label, value, min, max, step, format, onChange, hint,
}: {
  label: string; value: number; min: number; max: number; step: number;
  format?: (v: number) => string; onChange: (v: number) => void; hint?: string;
}) => (
  <div className="mb-16">
    <div className="font-bold mb-4 flex justify-between">
      <span>{label}</span>
      <span className="text-text-primary/60 font-normal">{format ? format(value) : value}</span>
    </div>
    <input
      type="range" min={min} max={max} step={step} value={value}
      className="input-range w-full"
      onChange={(e) => onChange(Number(e.target.value))}
    />
    {hint && <div className="text-xs text-text-primary/60 mt-4">{hint}</div>}
  </div>
);

const Check = ({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-start gap-8 cursor-pointer mb-16">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-16 h-16 mt-4 accent-primary" />
    <span>
      <span className="font-bold">{label}</span>
      {hint && <span className="block text-xs text-text-primary/60">{hint}</span>}
    </span>
  </label>
);

function Choice<T extends string>({
  value, options, onChange,
}: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-8 mb-16">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-16 py-8 rounded-8 text-sm font-bold border-2 transition-all ${
            value === o.id ? "border-primary bg-primary/10 text-primary" : "border-surface3 bg-surface1 hover:border-primary/50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const CafeSettings = ({
  cafeConfig, onChangeCafeConfig, gamesConfig, onChangeGamesConfig, backgroundConfig, onChangeBackgroundConfig,
}: Props) => {
  const [session, setSession] = useState<Connect4Session | null>(null);
  useEffect(() => gameManager.subscribe(setSession), []);

  const cafe = (p: Partial<CafeConfig>) => onChangeCafeConfig({ ...cafeConfig, ...p });
  const games = (p: Partial<GamesConfig>) => onChangeGamesConfig({ ...gamesConfig, ...p });
  const playing = session?.status === "playing";

  return (
    <div className="my-40">
      {/* ── Cafe ─────────────────────────────────────────────── */}
      <div className="my-16 typography-20 font-bold">Anime Cafe</div>

      {backgroundConfig.type !== "cafe" && (
        <div className="p-16 mb-16 bg-secondary/10 border border-secondary/30 rounded-8 text-sm">
          The cafe is switched off — your background is currently <b>{backgroundConfig.type}</b>.{" "}
          <button
            className="underline font-bold text-primary"
            onClick={() => onChangeBackgroundConfig({ ...backgroundConfig, type: "cafe" })}
          >
            Switch to the cafe
          </button>
        </div>
      )}

      <div className="p-16 bg-surface1 rounded-8">
        <div className="font-bold mb-8">Time of day</div>
        <Choice
          value={cafeConfig.timeOfDay}
          options={TIME_OF_DAY_OPTIONS.map((o) => ({ id: o.id, label: `${o.emoji} ${o.label}` }))}
          onChange={(timeOfDay) => cafe({ timeOfDay })}
        />

        <Check
          label="Walk around the cafe"
          hint="While nobody is talking to her, Miko strolls between spots in the cafe."
          checked={cafeConfig.wander}
          onChange={(wander) => cafe({ wander })}
        />
        <Slider
          label="Walking speed" value={cafeConfig.walkSpeed} min={0.3} max={1.6} step={0.05}
          format={(v) => `${v.toFixed(2)} m/s`} onChange={(walkSpeed) => cafe({ walkSpeed })}
        />
        <Slider
          label="Zoom out after being idle" value={cafeConfig.closeupHoldSeconds} min={2} max={60} step={1}
          format={(v) => `${v} s`}
          hint="When someone talks to her the camera moves in. It moves back out once the AI has been silent and idle for this long."
          onChange={(closeupHoldSeconds) => cafe({ closeupHoldSeconds })}
        />
        <Slider
          label="Close-up tightness" value={cafeConfig.closeupZoom} min={0.6} max={1.8} step={0.05}
          format={(v) => `${v.toFixed(2)}×`} onChange={(closeupZoom) => cafe({ closeupZoom })}
        />
      </div>

      {/* ── Games ────────────────────────────────────────────── */}
      <div className="mt-40 mb-16 typography-20 font-bold">Games</div>
      <div className="p-16 bg-surface1 rounded-8">
        <Check
          label="Enable chat games"
          hint="Connect 4 against Miko. Viewers play with commands in Twitch chat; you can also click the board or type the commands in the text box."
          checked={gamesConfig.enabled}
          onChange={(enabled) => games({ enabled })}
        />

        <div className="font-bold mb-8">Miko&apos;s skill</div>
        <Choice<Difficulty>
          value={gamesConfig.difficulty}
          options={[{ id: "easy", label: "Easy" }, { id: "normal", label: "Normal" }, { id: "hard", label: "Hard" }]}
          onChange={(difficulty) => games({ difficulty })}
        />

        <div className="font-bold mb-8">Who plays the pink discs</div>
        <Choice
          value={gamesConfig.whoCanPlay}
          options={[{ id: "everyone", label: "Everyone in chat" }, { id: "starter", label: "Only who typed !c4" }]}
          onChange={(whoCanPlay) => games({ whoCanPlay })}
        />

        <div className="font-bold mb-8">Screen corner</div>
        <Choice<GameCorner>
          value={gamesConfig.corner}
          options={[
            { id: "bottom-left", label: "Bottom left" }, { id: "bottom-right", label: "Bottom right" },
            { id: "top-left", label: "Top left" }, { id: "top-right", label: "Top right" },
          ]}
          onChange={(corner) => games({ corner })}
        />
        <div className="text-xs text-text-primary/60 -mt-8 mb-16">
          While you share your screen, it automatically moves to the side away from Miko.
        </div>

        <Check
          label="Miko reacts to the game"
          hint="She announces the game and reacts when it ends (uses your AI provider)."
          checked={gamesConfig.aiCommentary}
          onChange={(aiCommentary) => games({ aiCommentary })}
        />

        <div className="flex flex-wrap items-center gap-8 mt-8">
          {playing ? (
            <button
              onClick={() => gameManager.stop("stopped")}
              className="px-16 py-8 rounded-oval border-2 border-surface3 bg-surface1 hover:bg-surface3 font-bold text-sm text-secondary"
            >
              Stop game
            </button>
          ) : (
            <button
              disabled={!gamesConfig.enabled}
              onClick={() => gameManager.start("You")}
              className="px-16 py-8 rounded-oval bg-primary hover:bg-primary-hover disabled:opacity-40 text-white font-bold text-sm"
            >
              Start Connect 4
            </button>
          )}
          <span className="text-sm text-text-primary/60">
            {playing ? session?.message : session ? session.message : "No game running"}
          </span>
        </div>

        <div className="mt-16 text-sm">
          <div className="font-bold mb-4">Chat commands</div>
          {GAME_COMMANDS.map((c) => (
            <div key={c.cmd}>
              <code className="bg-surface3 px-4 rounded-4">{c.cmd}</code> — {c.text}
            </div>
          ))}
          <div>
            <code className="bg-surface3 px-4 rounded-4">!c4 stop</code> — end the game (mods and broadcaster)
          </div>
          <div className="text-xs text-text-primary/60 mt-8">
            The command list appears on screen in the corner while Twitch is connected.
          </div>
        </div>
      </div>
    </div>
  );
};
