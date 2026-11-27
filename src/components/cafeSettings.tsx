import React, { useContext, useEffect, useState } from "react";
import { ViewerContext } from "@/features/vrmViewer/viewerContext";
import { ProjectorConfig } from "@/features/projector/projectorConfig";
import { projectorStore } from "@/features/projector/projectorStore";
import { ActivityName, ActivityRate, CafeConfig, TIME_OF_DAY_OPTIONS } from "@/features/cafe/cafeConfig";
import { GameCorner, GamesConfig, GAME_COMMANDS } from "@/features/games/gamesConfig";
import { Difficulty } from "@/features/games/connect4";
import { gameManager, Connect4Session } from "@/features/games/gameManager";
import { BackgroundConfig } from "@/features/background/backgroundConfig";

type Props = {
  cafeConfig: CafeConfig;
  onChangeCafeConfig: (c: CafeConfig) => void;
  gamesConfig: GamesConfig;
  onChangeGamesConfig: (c: GamesConfig) => void;
  projectorConfig: ProjectorConfig;
  onChangeProjectorConfig: (c: ProjectorConfig) => void;
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
  cafeConfig, onChangeCafeConfig, gamesConfig, onChangeGamesConfig, projectorConfig, onChangeProjectorConfig,
  backgroundConfig, onChangeBackgroundConfig,
}: Props) => {
  const [session, setSession] = useState<Connect4Session | null>(null);
  useEffect(() => gameManager.subscribe(setSession), []);
  const { viewer } = useContext(ViewerContext);
  const [, bump] = useState(0);
  useEffect(() => projectorStore.subscribe(() => bump((n) => n + 1)), []);
  const proj = (p: Partial<ProjectorConfig>) => onChangeProjectorConfig({ ...projectorConfig, ...p });
  const act = (name: ActivityName) => viewer.cafe.triggerActivity(name);

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

        <div className="font-bold mt-16 mb-8">Things she does between walks</div>
        <Check
          label="Sit at a table"
          hint="Pulls out a chair, sits and sips coffee, then gets up and walks on."
          checked={cafeConfig.activities.sit}
          onChange={(sit) => cafe({ activities: { ...cafeConfig.activities, sit } })}
        />
        <Check
          label="Pat the cat"
          hint="Sits on the window bench and pets the cat. The camera moves in to show it."
          checked={cafeConfig.activities.cat}
          onChange={(cat) => cafe({ activities: { ...cafeConfig.activities, cat } })}
        />
        <Check
          label="Serve coffee"
          hint="Makes a coffee at the counter and carries it to a table on a tray."
          checked={cafeConfig.activities.coffee}
          onChange={(coffee) => cafe({ activities: { ...cafeConfig.activities, coffee } })}
        />
        <div className="font-bold mb-8">How often</div>
        <Choice<ActivityRate>
          value={cafeConfig.activityRate}
          options={[{ id: "off", label: "Never" }, { id: "rare", label: "Rarely" }, { id: "normal", label: "Sometimes" }, { id: "often", label: "Often" }]}
          onChange={(activityRate) => cafe({ activityRate })}
        />
        <Slider
          label="Time seated in a chair" value={cafeConfig.sitSeconds} min={10} max={120} step={5}
          format={(v) => `${v} s`} onChange={(sitSeconds) => cafe({ sitSeconds })}
        />
        <div className="flex flex-wrap gap-8">
          {([["sit", "☕ Sit now"], ["cat", "🐱 Pat the cat now"], ["coffee", "🫖 Serve coffee now"]] as [ActivityName, string][]).map(([n, label]) => (
            <button key={n} onClick={() => act(n)} className="px-16 py-8 rounded-oval border-2 border-surface3 bg-surface1 hover:bg-surface3 font-bold text-sm">
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Projector ────────────────────────────────────────── */}
      <div className="mt-40 mb-16 typography-20 font-bold">Projector screen</div>
      <div className="p-16 bg-surface1 rounded-8">
        <div className="text-sm text-text-primary/70 mb-16">
          A pull-down screen appears in the cafe when there is something to show: a video or stream below, or
          Twitch chat connected with clips available. In Twitch chat, <code className="bg-surface3 px-4 rounded-4">!so</code> (or{" "}
          <code className="bg-surface3 px-4 rounded-4">!so channel</code>) makes Miko walk to the screen and play a random clip.
          Right now the screen is <b>{projectorStore.available ? "available" : "hidden (nothing to show)"}</b>.
        </div>

        <div className="font-bold mb-4">Video or stream on the screen</div>
        <input
          type="text" value={projectorConfig.source} placeholder="https://… (mp4, .m3u8, YouTube, Twitch, VDO.Ninja)"
          className="w-full px-16 py-8 rounded-8 bg-surface3 mb-8"
          onChange={(e) => proj({ source: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-8 mb-16">
          <label className="px-16 py-8 rounded-oval border-2 border-surface3 bg-surface1 hover:bg-surface3 font-bold text-sm cursor-pointer">
            Choose a video file…
            <input
              type="file" accept="video/*" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) proj({ source: URL.createObjectURL(f) });
              }}
            />
          </label>
          {projectorConfig.source && (
            <button onClick={() => proj({ source: "" })} className="px-16 py-8 rounded-oval border-2 border-surface3 hover:bg-surface3 font-bold text-sm text-secondary">
              Clear
            </button>
          )}
          <span className="text-xs text-text-primary/60">A chosen file lasts until you reload the page.</span>
        </div>
        <Check label="Play its sound" hint="Off by default so it never talks over Miko." checked={projectorConfig.sourceAudio} onChange={(sourceAudio) => proj({ sourceAudio })} />

        <div className="font-bold mt-16 mb-8">!so clips</div>
        <Check
          label="Use my channel's Twitch clips"
          hint="Needs the Client ID and token from the Twitch settings (the same ones used for alerts)."
          checked={projectorConfig.useChannelClips}
          onChange={(useChannelClips) => proj({ useChannelClips })}
        />
        <div className="text-sm mb-4">Extra clip or video links, one per line:</div>
        <textarea
          value={projectorConfig.clipList} rows={3} placeholder="https://clips.twitch.tv/…"
          className="w-full px-16 py-8 rounded-8 bg-surface3 mb-16"
          onChange={(e) => proj({ clipList: e.target.value })}
        />
        <Check label="Let everyone in chat use !so" hint="Otherwise only mods and the broadcaster can." checked={projectorConfig.everyoneCanShoutout} onChange={(everyoneCanShoutout) => proj({ everyoneCanShoutout })} />
        <Slider
          label="Longest clip" value={projectorConfig.maxClipSeconds} min={10} max={120} step={5}
          format={(v) => `${v} s`} hint="Safety cut-off for clips whose length isn't known."
          onChange={(maxClipSeconds) => proj({ maxClipSeconds })}
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
