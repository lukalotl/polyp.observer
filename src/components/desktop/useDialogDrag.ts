import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent,
  type KeyboardEvent,
} from "react";

export function useDialogDrag(dialog: RefObject<HTMLDialogElement | null>) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const gesture = useRef<{
    x: number;
    y: number;
    offset: typeof offset;
    rect: DOMRect;
    pointerId: number;
  } | null>(null);
  const constrain = (
    x: number,
    y: number,
    rect: DOMRect,
    previous: typeof offset,
  ) => ({
    x:
      previous.x +
      Math.max(6 - rect.left, Math.min(innerWidth - rect.right - 6, x)),
    y:
      previous.y +
      Math.max(6 - rect.top, Math.min(innerHeight - rect.bottom - 6, y)),
  });
  useEffect(() => {
    const resize = () => setOffset({ x: 0, y: 0 });
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  return {
    style: { transform: "translate(" + offset.x + "px, " + offset.y + "px)" },
    handle: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || !dialog.current) return;
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          offset,
          rect: dialog.current.getBoundingClientRect(),
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        setOffset(
          constrain(
            event.clientX - current.x,
            event.clientY - current.y,
            current.rect,
            current.offset,
          ),
        );
      },
      onPointerUp() {
        gesture.current = null;
      },
      onPointerCancel() {
        gesture.current = null;
      },
      onLostPointerCapture() {
        gesture.current = null;
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          ) ||
          !dialog.current
        )
          return;
        event.preventDefault();
        const step = event.shiftKey ? 1 : 10;
        setOffset(
          constrain(
            event.key === "ArrowLeft"
              ? -step
              : event.key === "ArrowRight"
                ? step
                : 0,
            event.key === "ArrowUp"
              ? -step
              : event.key === "ArrowDown"
                ? step
                : 0,
            dialog.current.getBoundingClientRect(),
            offset,
          ),
        );
      },
    },
  };
}
