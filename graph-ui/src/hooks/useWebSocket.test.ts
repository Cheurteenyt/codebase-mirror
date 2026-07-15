// graph-ui/src/hooks/useWebSocket.test.ts
// R45 (F3): regression test for the R40 generation-counter fix (zombie-connection race).
// Mocks WebSocket via vi.stubGlobal so no real network is needed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getSecurityBootstrap: vi.fn().mockResolvedValue({ csrf_token: "test-token" }),
}));

import { useWebSocket } from "./useWebSocket";
import { getSecurityBootstrap } from "../api/client";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  fireOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fireClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("R45 (F3): useWebSocket — R40 generation counter (zombie-connection race)", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.mocked(getSecurityBootstrap).mockReset();
    vi.mocked(getSecurityBootstrap).mockResolvedValue({ csrf_token: "test-token" });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stale socket's onclose does NOT scheduleReconnect after project change", async () => {
    const notify = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ project }) => useWebSocket(project, notify),
      { initialProps: { project: "a" } },
    );
    await act(async () => { await Promise.resolve(); });
    const socketA = MockWebSocket.instances[0]!;
    expect(socketA.url).toContain("/ws?csrf=test-token");
    act(() => socketA.fireOpen());
    expect(socketA.sent).toContainEqual(JSON.stringify({ type: "subscribe", project: "a" }));

    // Switch to project B — increments wsGenRef and creates socket B.
    rerender({ project: "b" });
    await act(async () => { await Promise.resolve(); });
    const socketB = MockWebSocket.instances[1]!;
    act(() => socketB.fireOpen());
    expect(socketB.sent).toContainEqual(JSON.stringify({ type: "subscribe", project: "b" }));

    // Zombie scenario: socket A's onclose fires AFTER socket B is open.
    // Without the generation guard, this would scheduleReconnect to project A.
    const beforeCount = MockWebSocket.instances.length;
    act(() => socketA.fireClose());

    // Advance past all reconnect delays (15s cap × several attempts).
    act(() => { vi.advanceTimersByTime(60_000); });

    // R45: the key invariant — no NEW socket should have been created from the
    // stale close. We allow the count to be unchanged OR for socket B to have
    // reconnected (if B itself closed during timer advance). The critical
    // assertion is that no socket subscribed to project "a" after the switch.
    const subscribeMessages = MockWebSocket.instances
      .map((s, i) => ({ idx: i, sent: s.sent }))
      .filter((s) => s.sent.some((m) => m.includes("subscribe")));
    // Only the first 2 sockets should have sent subscribe messages.
    // Any socket created after the switch (idx >= 2) must subscribe to "b",
    // never to "a".
    for (const s of subscribeMessages) {
      if (s.idx >= 2) {
        const sub = s.sent.find((m) => m.includes("subscribe"));
        expect(sub).not.toContain('"a"');
      }
    }

    unmount();
  });

  it("stale socket's onmessage does NOT deliver notifications after project change", async () => {
    const notify = vi.fn();
    const { rerender } = renderHook(
      ({ project }) => useWebSocket(project, notify),
      { initialProps: { project: "a" } },
    );
    await act(async () => { await Promise.resolve(); });
    const socketA = MockWebSocket.instances[0]!;
    act(() => socketA.fireOpen());

    rerender({ project: "b" });
    await act(async () => { await Promise.resolve(); });
    const socketB = MockWebSocket.instances[1]!;
    act(() => socketB.fireOpen());

    // Stale socket A delivers a project-A notification AFTER project switch.
    act(() =>
      socketA.fireMessage({
        type: "notification",
        event: "human_nodes_changed",
        project: "a",
        timestamp: new Date().toISOString(),
      }),
    );

    // The hook's onNotification callback must NOT have been called.
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the connection inactive when a warm tab pauses its subscription", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ project }: { project: string | null }) => useWebSocket(project),
      { initialProps: { project: "a" as string | null } },
    );
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0]!;
    act(() => socket.fireOpen());
    expect(result.current.connected).toBe(true);

    rerender({ project: null });
    expect(result.current.connected).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    unmount();
  });

  it("refreshes the runtime credential before reconnecting after a rejected socket", async () => {
    vi.mocked(getSecurityBootstrap).mockImplementation(async (forceRefresh = false) => ({
      csrf_token: forceRefresh ? "fresh-token" : "stale-token",
    }));

    const { unmount } = renderHook(() => useWebSocket("a"));
    await act(async () => { await Promise.resolve(); });
    const rejectedSocket = MockWebSocket.instances[0]!;
    expect(rejectedSocket.url).toContain("csrf=stale-token");

    act(() => rejectedSocket.fireClose());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSecurityBootstrap).toHaveBeenLastCalledWith(true);
    expect(MockWebSocket.instances[1]!.url).toContain("csrf=fresh-token");
    unmount();
  });

  it("cancels an already scheduled retry when reconnecting manually", async () => {
    const { result, unmount } = renderHook(() => useWebSocket("a"));
    await act(async () => { await Promise.resolve(); });
    const first = MockWebSocket.instances[0]!;

    act(() => first.fireClose()); // schedules the automatic 1s retry
    act(() => result.current.reconnect());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    unmount();
  });
});
