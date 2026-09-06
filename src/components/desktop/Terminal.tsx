import { useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, RotateCcw, Wifi } from "lucide-react";
import { useDesktop } from "./Desktop";
import { PipeField, PIPE_GLYPHS } from "./pipes";

export const TERMINAL_COLORS = [
  "#df6c7c",
  "#e5c995",
  "#90a98e",
  "#8da5a1",
  "#bfc8cc",
  "#757f83",
  "#526571",
];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function DesktopBar({
  connected,
  workers,
  limit,
  onReset,
}: {
  connected: boolean;
  workers: number;
  limit: number;
  onReset?: () => void;
}) {
  const now = useClock();
  const { reset } = useDesktop();
  return (
    <div className="desktop-bar" aria-label="Desktop status">
      <div className="desktop-workspaces">
        <span className="workspace-current">1</span>
        <span>2</span>
        <span>3</span>
        <span className="bar-separator">│</span>
        <span>✳ polyp</span>
        <span className="bar-separator">│</span>
        <span className="bar-sage">
          {connected ? "● connected" : "○ connecting"}
        </span>
      </div>
      <time className="bar-time">
        {now.toLocaleDateString(undefined, {
          weekday: "short",
          day: "2-digit",
          month: "short",
        })}{" "}
        │{" "}
        {now.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </time>
      <div className="bar-right">
        <span>
          ◈ {workers}/{limit || "—"} workers
        </span>
        <span className="bar-separator">│</span>
        <button
          onClick={() => {
            reset();
            onReset?.();
          }}
          aria-label="Reset window layout"
          title="Restore the original window arrangement"
        >
          <RotateCcw size={10} />
          <span>reset layout</span>
        </button>
        <Wifi size={12} />
      </div>
    </div>
  );
}

const DIGITS: Record<string, string[]> = {
  "0": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
  "1": ["00110", "01110", "00110", "00110", "00110", "00110", "01111"],
  "2": ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  "3": ["11111", "00001", "00001", "01111", "00001", "00001", "11111"],
  "4": ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  "5": ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  "6": ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
  "7": ["11111", "00001", "00001", "00010", "00100", "00100", "00100"],
  "8": ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
  "9": ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
  ":": ["0", "1", "1", "0", "1", "1", "0"],
};

export function TerminalClock() {
  const now = useClock();
  const value = now.toLocaleTimeString("en-GB", { hour12: false });
  let offset = 0;
  const pixels = value.split("").flatMap((digit, index) => {
    const shape = DIGITS[digit] ?? DIGITS["0"];
    const left = offset;
    offset += shape[0].length + 1.2;
    return shape.flatMap((row, y) =>
      row
        .split("")
        .map((filled, x) =>
          filled === "1" ? (
            <rect
              key={index + ":" + y + ":" + x}
              x={left + x}
              y={y}
              width="1.02"
              height="1.02"
            />
          ) : null,
        ),
    );
  });
  return (
    <div className="terminal-clock">
      <time dateTime={now.toISOString()} aria-label={"Local time " + value}>
        <svg
          viewBox={"0 0 " + (offset - 1.2) + " 7"}
          aria-hidden="true"
          shapeRendering="crispEdges"
        >
          {pixels}
        </svg>
      </time>
      <span>
        {now.toLocaleDateString("sv-SE")}{" "}
        <b>[{now.getHours() < 12 ? "AM" : "PM"}]</b>
      </span>
    </div>
  );
}

export function TerminalIdentity({
  model,
  connected,
  runs,
  workers,
  limit,
}: {
  model: string | null;
  connected: boolean;
  runs: number;
  workers: number;
  limit: number;
}) {
  return (
    <div className="terminal-identity">
      <pre className="polyp-wordmark" aria-label="Polyp">
        {
          "              __\n   ___  ___  / /_ _____\n  / _ \\/ _ \\/ / // / _ \\\n / .__/\\___/_/\\_, / .__/\n/_/          /___/_/"
        }
      </pre>
      <div className="terminal-user">
        <span>observer</span>
        <span className="terminal-at">@</span>
        <span>polyp</span>
        <span className="terminal-rule">──────────────</span>
      </div>
      <dl className="system-readout">
        <div>
          <dt>◈ engine</dt>
          <dd>{model?.replace("ca-moore-", "") ?? "waiting for VM"}</dd>
        </div>
        <div>
          <dt>⌁ session</dt>
          <dd className="text-gold">
            {connected ? "live research" : "connecting"}
          </dd>
        </div>
        <div>
          <dt>▣ workers</dt>
          <dd>
            {workers} / {limit || "—"} allocated
          </dd>
        </div>
        <div>
          <dt>◇ runs</dt>
          <dd className="text-sage">{runs} stored experiments</dd>
        </div>
        <div>
          <dt>⌘ shell</dt>
          <dd>polyp.observer</dd>
        </div>
        <div>
          <dt>◉ colors</dt>
          <dd className="terminal-swatches">
            {TERMINAL_COLORS.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </dd>
        </div>
      </dl>
      <div className="terminal-prompt">
        <span>❯</span> <span>ls ./experiments</span>
        <i />
      </div>
    </div>
  );
}

/** Decorative terminal art only. This never evaluates or changes a research run. */
export function AsciiArt({
  mode = "pipes",
  controls = true,
}: {
  mode?: "pipes" | "contours";
  controls?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  const fieldRef = useRef<{ seed: number; field: PipeField } | null>(null);
  const [seed, setSeed] = useState(17);
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const context = element.getContext("2d");
    if (!context) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = preference.matches,
      width = 0,
      height = 0,
      tick = 0;
    let timer: ReturnType<typeof setTimeout>;
    const preferenceChanged = () => {
      reduced = preference.matches;
      clearTimeout(timer);
      if (!reduced && !paused) timer = setTimeout(animate, 140);
    };
    preference.addEventListener("change", preferenceChanged);
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    });
    const hash = (n: number) => {
      const value = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
      return value - Math.floor(value);
    };
    function draw() {
      if (!context || !width || !height) return;
      context.clearRect(0, 0, width, height);
      const cellW = mode === "pipes" ? 12 : 8,
        cellH = mode === "pipes" ? 18 : 12;
      const columns = Math.ceil(width / cellW),
        rows = Math.ceil(height / cellH);
      context.font =
        (mode === "pipes" ? "bold 20px" : "12px") + " 'Polyp Mono', monospace";
      context.textBaseline = "top";
      if (mode === "pipes") {
        if (
          !fieldRef.current ||
          fieldRef.current.seed !== seed ||
          fieldRef.current.field.width !== columns ||
          fieldRef.current.field.height !== rows
        )
          fieldRef.current = {
            seed,
            field: new PipeField(columns, rows, seed),
          };
        const field = fieldRef.current.field;
        if (!paused && !reduced) field.advance(2);
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < columns; x++) {
            const index = y * columns + x,
              glyph = PIPE_GLYPHS[field.cells[index]];
            if (glyph === " ") continue;
            context.fillStyle = TERMINAL_COLORS[field.colors[index]];
            context.globalAlpha =
              0.66 + hash(field.colors[index] * 79 + x) * 0.34;
            context.fillText(glyph, x * cellW, y * cellH);
          }
      } else {
        const glyphs = " .·:+=*#%@";
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < columns; x++) {
            const distance = Math.hypot((x - columns / 2) / 1.8, y - rows / 2);
            const wave = Math.sin(
              distance * 0.55 -
                tick * 0.055 +
                Math.sin(x * 0.18 + tick * 0.025) * 2,
            );
            const density = (wave + 1) / 2;
            context.fillStyle =
              TERMINAL_COLORS[
                Math.floor(((x / columns) * 3 + (y / rows) * 3 + seed) % 5)
              ];
            context.globalAlpha = 0.2 + density * 0.7;
            context.fillText(
              glyphs[Math.floor(density * (glyphs.length - 1))],
              x * cellW,
              y * cellH,
            );
          }
      }
      context.globalAlpha = 1;
    }
    const animate = () => {
      if (!document.hidden && !paused && !reduced) {
        tick++;
        draw();
      }
      if (!paused && !reduced) timer = setTimeout(animate, 140);
    };
    resize.observe(element);
    if (!paused && !reduced) timer = setTimeout(animate, 140);
    return () => {
      clearTimeout(timer);
      resize.disconnect();
      preference.removeEventListener("change", preferenceChanged);
    };
  }, [mode, paused, seed]);
  return (
    <div className={"ascii-art ascii-" + mode}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={
          mode === "pipes"
            ? "Colorful decorative ASCII pipes"
            : "Decorative ASCII interference field"
        }
      />
      {controls && (
        <div className="ascii-controls">
          <span>
            pipes.sh <i>· decorative</i>
          </span>
          <button
            aria-label={
              paused ? "Play ASCII animation" : "Pause ASCII animation"
            }
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={11} /> : <Pause size={11} />}
          </button>
          <button
            aria-label="Reseed ASCII pattern"
            onClick={() => setSeed((value) => value + 13)}
          >
            <RefreshCw size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
