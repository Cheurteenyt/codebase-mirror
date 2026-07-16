import { useCallback, useRef } from "react";

interface ResizeHandleProps {
  side: "left" | "right"; /* which side the panel is on */
  onResize: (delta: number) => void;
}

export function ResizeHandle({ side, onResize }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      lastX.current = e.clientX;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      /* Left panel: drag right = bigger (positive delta).
       * Right panel: drag left = bigger (negative delta → invert). */
      onResize(side === "left" ? delta : -delta);
    },
    [onResize, side],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} graph panel`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const physicalDelta = event.key === "ArrowRight" ? 10 : -10;
        onResize(side === "left" ? physicalDelta : -physicalDelta);
      }}
      className="w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors shrink-0 focus-visible:outline-none focus-visible:bg-primary/50 focus-visible:ring-1 focus-visible:ring-primary/70"
    />
  );
}
