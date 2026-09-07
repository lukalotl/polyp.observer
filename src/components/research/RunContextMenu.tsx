import { useEffect, useLayoutEffect, useRef } from "react";
import { Play, Square } from "lucide-react";
import type { RunSummary } from "../../research/types";

export default function RunContextMenu({
  run,
  x,
  y,
  busy,
  onAction,
  onClose,
}: {
  run: RunSummary;
  x: number;
  y: number;
  busy: boolean;
  onAction: (action: "start" | "pause") => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    (
      element.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      element
    ).focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Run actions"
      tabIndex={-1}
      className="run-context-menu"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        const items = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[index]?.focus();
      }}
    >
      <span className="run-context-title" title={run.name}>
        {run.name}
      </span>
      <button
        role="menuitem"
        disabled={busy || run.status !== "paused"}
        onClick={() => onAction("start")}
      >
        <Play size={13} /> Start
      </button>
      <button
        role="menuitem"
        disabled={
          busy || !["running", "queued", "starting"].includes(run.status)
        }
        title="Stop and save progress; the run can be resumed"
        onClick={() => onAction("pause")}
      >
        <Square size={13} /> Stop
      </button>
    </div>
  );
}
