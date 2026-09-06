import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  paneLayout,
  readPanePreferences,
  PANE_SIZES_KEY,
  type Pane,
  type PaneVisibility,
} from "./paneSizing";

export function usePaneSizes(visible: PaneVisibility) {
  const [viewport, setViewport] = useState(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const [preferences, setPreferences] = useState(() => {
    try {
      return readPanePreferences(localStorage.getItem(PANE_SIZES_KEY));
    } catch {
      return {};
    }
  });
  const layout = paneLayout(
    viewport.width,
    viewport.height,
    preferences,
    visible,
  );
  useEffect(() => {
    const resize = () =>
      setViewport({ width: innerWidth, height: innerHeight });
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          PANE_SIZES_KEY,
          JSON.stringify({ version: 1, ...preferences }),
        );
      } catch {
        /* Optional layout preference. */
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [preferences]);
  return {
    style: {
      "--registry-width": layout.registry.value + "px",
      "--metrics-height": layout.metrics.value + "px",
      "--analysis-height": layout.analysis.value + "px",
      "--inspector-min": layout.inspectorMin + "px",
    } as CSSProperties,
    divider(pane: Pane) {
      return {
        pane,
        ...layout[pane],
        onChange(value: number) {
          const bounded = Math.max(
            layout[pane].min,
            Math.min(layout[pane].max, value),
          );
          setPreferences((previous) => ({ ...previous, [pane]: bounded }));
        },
        onReset() {
          setPreferences((previous) => {
            const next = { ...previous };
            delete next[pane];
            return next;
          });
        },
      };
    },
  };
}

export function PaneDivider({
  pane,
  value,
  min,
  max,
  onChange,
  onReset,
}: {
  pane: Pane;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const gesture = useRef<{
    value: number;
    position: number;
    pointerId: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = pane !== "registry";
  const direction = pane === "analysis" ? -1 : 1;
  const end = (event: PointerEvent<HTMLSpanElement>, cancel = false) => {
    if (cancel && gesture.current) onChange(gesture.current.value);
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <span
      role="separator"
      tabIndex={0}
      aria-label={
        pane === "registry"
          ? "Resize run registry"
          : pane === "metrics"
            ? "Resize run metrics"
            : "Resize analysis and inspector"
      }
      aria-controls={"pane-" + pane}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={Math.round(value) + " pixels"}
      title="Drag edge to resize · arrow keys to adjust · double-click or Enter to reset"
      className={"pane-divider pane-divider-" + pane}
      data-resizing={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        gesture.current = {
          value,
          position: horizontal ? event.clientY : event.clientX,
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const position = horizontal ? event.clientY : event.clientX;
        onChange(current.value + (position - current.position) * direction);
      }}
      onPointerUp={(event) => end(event)}
      onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={() => {
        gesture.current = null;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        // A focused separator owns its keys; Space must not start/pause research.
        if (event.code === "Space") {
          event.preventDefault();
          return;
        }
        if (event.key === "Escape" && gesture.current) {
          event.preventDefault();
          onChange(gesture.current.value);
          gesture.current = null;
          setDragging(false);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onReset();
          return;
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          onChange(event.key === "Home" ? min : max);
          return;
        }
        const keys = horizontal
          ? ["ArrowUp", "ArrowDown"]
          : ["ArrowLeft", "ArrowRight"];
        const index = keys.indexOf(event.key);
        if (index < 0) return;
        event.preventDefault();
        onChange(
          value +
            (index === 0 ? -1 : 1) * direction * (event.shiftKey ? 1 : 10),
        );
      }}
    />
  );
}
