import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from "react";
import { Maximize2, Minimize2, GripHorizontal } from "lucide-react";
import {
  constrainFrame,
  defaultFrames,
  desktopSize,
  LAYOUT_KEY,
  restoreFrames,
  WINDOW_IDS,
  type Frame,
  type Frames,
  type WindowId,
} from "./layout";

interface DesktopContextValue {
  frames: Frames;
  size: ReturnType<typeof desktopSize>;
  order: WindowId[];
  resetVersion: number;
  update: (id: WindowId, value: Frame) => void;
  raise: (id: WindowId) => void;
  reset: () => void;
}
const DesktopContext = createContext<DesktopContextValue | null>(null);
function savedLayout() {
  try {
    return localStorage.getItem(LAYOUT_KEY);
  } catch {
    return null;
  }
}

export function Desktop({ children }: { children: ReactNode }) {
  const [size, setSize] = useState(() => desktopSize(innerWidth, innerHeight));
  const [frames, setFrames] = useState(() =>
    restoreFrames(savedLayout(), size),
  );
  const [order, setOrder] = useState<WindowId[]>([...WINDOW_IDS]);
  const [resetVersion, setResetVersion] = useState(0);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const update = useCallback(
    (id: WindowId, value: Frame) => {
      setFrames((previous) => ({
        ...previous,
        [id]: constrainFrame(value, size),
      }));
    },
    [size],
  );
  const raise = useCallback((id: WindowId) => {
    setOrder((previous) =>
      previous.at(-1) === id
        ? previous
        : [...previous.filter((entry) => entry !== id), id],
    );
  }, []);
  const reset = useCallback(() => {
    setFrames(defaultFrames(size));
    setOrder([...WINDOW_IDS]);
    setResetVersion((value) => value + 1);
  }, [size]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          LAYOUT_KEY,
          JSON.stringify({ version: 1, size, frames }),
        );
      } catch {
        /* Optional preference. */
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [frames, size]);
  useEffect(() => {
    const resize = () => {
      const next = desktopSize(innerWidth, innerHeight);
      setFrames(
        restoreFrames(
          JSON.stringify({ version: 1, size, frames: framesRef.current }),
          next,
        ),
      );
      setSize(next);
    };
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, [size]);
  return (
    <DesktopContext.Provider
      value={{ frames, size, order, resetVersion, update, raise, reset }}
    >
      {children}
    </DesktopContext.Provider>
  );
}

export function useDesktop() {
  const value = useContext(DesktopContext);
  if (!value) throw new Error("Floating windows require a desktop.");
  return value;
}

export function FloatingWindow({
  id,
  title,
  children,
  className = "",
  full = false,
}: {
  id: WindowId;
  title: string;
  children: ReactNode;
  className?: string;
  full?: boolean;
}) {
  const { frames, size, order, resetVersion, update, raise } = useDesktop();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => setMaximized(false), [resetVersion]);
  const gesture = useRef<{
    start: Frame;
    x: number;
    y: number;
    kind: "move" | "resize";
    pointerId: number;
  } | null>(null);
  const expanded = full || maximized;
  const frame = expanded
    ? {
        x: 6,
        y: 6,
        width: size.width - 12,
        height: Math.min(size.height - 12, innerHeight - 88),
      }
    : frames[id];
  const begin = (
    event: PointerEvent<HTMLButtonElement>,
    kind: "move" | "resize",
  ) => {
    if (event.button !== 0 || expanded) return;
    raise(id);
    gesture.current = {
      start: frames[id],
      x: event.clientX,
      y: event.clientY,
      kind,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    update(
      id,
      current.kind === "move"
        ? { ...current.start, x: current.start.x + dx, y: current.start.y + dy }
        : {
            ...current.start,
            width: current.start.width + dx,
            height: current.start.height + dy,
          },
    );
  };
  const end = () => {
    gesture.current = null;
  };
  const keyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    kind: "move" | "resize",
  ) => {
    if (
      expanded ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx =
      event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy =
      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    raise(id);
    update(
      id,
      kind === "move"
        ? { ...frame, x: frame.x + dx, y: frame.y + dy }
        : { ...frame, width: frame.width + dx, height: frame.height + dy },
    );
  };
  const style: CSSProperties = {
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
    zIndex: expanded ? 90 : 10 + order.indexOf(id),
  };
  return (
    <div
      className={
        "floating-window panel-" +
        id +
        (expanded ? " is-maximized " : " ") +
        className
      }
      style={style}
      data-window={id}
      onPointerDownCapture={() => raise(id)}
      onFocusCapture={() => raise(id)}
    >
      <header className="window-chrome">
        <button
          className="window-grip"
          aria-label={"Move " + title + " window"}
          title="Drag to move · arrow keys to move · Shift for fine adjustment"
          onPointerDown={(event) => begin(event, "move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onKeyDown={(event) => keyboard(event, "move")}
          onDoubleClick={() => setMaximized((value) => !value)}
        >
          <span className="window-index">
            {String(WINDOW_IDS.indexOf(id) + 1).padStart(2, "0")}
          </span>
          <span className="window-title">{title}</span>
          <span className="window-rule" />
          <GripHorizontal size={12} />
        </button>
        {!full && (
          <button
            className="window-expand"
            aria-label={
              (maximized ? "Restore " : "Maximize ") + title + " window"
            }
            onClick={() => {
              raise(id);
              setMaximized((value) => !value);
            }}
          >
            {maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
        )}
      </header>
      <div className="window-content">{children}</div>
      {!expanded && (
        <button
          className="window-resize"
          aria-label={"Resize " + title + " window"}
          title="Drag to resize · arrow keys to resize"
          onPointerDown={(event) => begin(event, "resize")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onKeyDown={(event) => keyboard(event, "resize")}
        />
      )}
    </div>
  );
}
