// graph-ui/src/components/ResizeHandle.test.tsx
// R46 (F2): regression test for the R40 onPointerCancel fix (UI-11).
// A cancelled pointer event (OS-level touch interruption) must release the
// drag — otherwise subsequent pointermove events keep resizing the panel
// even though no button is held.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ResizeHandle } from "./ResizeHandle";

describe("R40 (UI-11): ResizeHandle releases drag on pointerCancel", () => {
  it("does NOT call onResize after pointerCancel (drag must be released)", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle side="left" onResize={onResize} />);
    const handle = container.firstChild as HTMLElement;

    // Begin a drag — setPointerCapture is a no-op in jsdom but the drag
    // state (dragging.current) is set by onPointerDown.
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    // onResize should have been called at least once during the drag.
    const callsDuringDrag = onResize.mock.calls.length;
    expect(callsDuringDrag).toBeGreaterThanOrEqual(1);

    // R40 fix: pointerCancel must release the drag.
    fireEvent.pointerCancel(handle, { clientX: 120, pointerId: 1 });

    // Subsequent pointermove must NOT fire onResize — drag is over.
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(onResize.mock.calls.length).toBe(callsDuringDrag); // no new calls
  });

  it("is keyboard accessible and moves in physical screen direction", () => {
    const onResize = vi.fn();
    const { getByRole } = render(<ResizeHandle side="right" onResize={onResize} />);
    const handle = getByRole("separator", { name: "Resize right graph panel" });

    expect(handle).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(onResize).toHaveBeenNthCalledWith(1, -10);
    expect(onResize).toHaveBeenNthCalledWith(2, 10);
  });
});
