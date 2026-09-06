import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useResearch } from "./useResearch";
import {
  CAPACITY,
  SELECTED_KEY,
  changed,
  installResearchNetwork,
  researchFixture,
  ResearchSocket,
  runList,
  type ControlledHttp,
} from "./test/researchFixtures";
import type { RunDetail } from "./research/types";

let http: ControlledHttp;
let first: Awaited<ReturnType<typeof researchFixture>>;
let second: Awaited<ReturnType<typeof researchFixture>>;
beforeAll(async () => {
  first = await researchFixture();
  second = await researchFixture("run-b", 2, {
    name: "Held-out research",
    seed: "islands",
    validationSeeds: [42],
  });
});
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  http = installResearchNetwork();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function mount(details: RunDetail[] = [first.detail, second.detail]) {
  const hook = renderHook(() => useResearch());
  const socket = ResearchSocket.instances.at(-1)!;
  await http.reply("/api/runs", runList(details));
  if (hook.result.current.selectedId)
    await http.reply(
      `/api/runs/${hook.result.current.selectedId}`,
      details.find(
        (value) => value.summary.id === hook.result.current.selectedId,
      ),
    );
  socket.hello();
  return { ...hook, socket };
}

describe("persistent VM run discovery and selection", () => {
  it("uses the configured VM for subscriptions while HTTP uses the site's rewrite", async () => {
    vi.stubEnv("VITE_RESEARCH_WS_ORIGIN", "https://research.example.com");
    const { socket, result } = await mount();
    expect(String(socket.url)).toBe("wss://research.example.com/api/research/ws");
    expect(http.requests[0].path).toBe("/api/runs");
    expect(result.current.connection).toBe("connected");
    expect(result.current.detail).toEqual(first.detail);
  });
  it("loads the registry, subscribes to one run, and remembers only its identity", async () => {
    const hook = renderHook(() => useResearch());
    const socket = ResearchSocket.instances[0];
    expect(hook.result.current).toMatchObject({
      loading: true,
      detail: null,
      connection: "connecting",
    });
    expect(new URL(socket.url).pathname).toBe("/api/research/ws");
    expect(new URL(socket.url).protocol).toBe("ws:");
    await http.reply("/api/runs", runList([first.detail]));
    expect(hook.result.current).toMatchObject({
      loading: false,
      selectedId: "run-a",
      capacity: CAPACITY,
    });
    await http.reply("/api/runs/run-a", first.detail);
    socket.hello();
    expect(hook.result.current.detail).toEqual(first.detail);
    expect(socket.messages).toEqual([{ type: "subscribe", runId: "run-a" }]);
    expect(localStorage.getItem(SELECTED_KEY)).toBe("run-a");
    expect(localStorage.length).toBe(1);
    expect(http.mutations).toHaveLength(0);
  });
  it("restores an existing run instead of silently creating or restarting a job", async () => {
    localStorage.setItem(SELECTED_KEY, "run-b");
    const { result, socket } = await mount();
    expect(result.current.detail).toEqual(second.detail);
    expect(socket.messages.at(-1)).toEqual({
      type: "subscribe",
      runId: "run-b",
    });
    expect(http.mutations).toHaveLength(0);
  });
  it("recovers an unavailable saved identity and skips archived runs for initial selection", async () => {
    localStorage.setItem(SELECTED_KEY, "missing");
    const archived = changed(first.detail, { status: "archived" });
    const hook = renderHook(() => useResearch());
    await http.reply("/api/runs", runList([archived, second.detail]));
    await http.reply("/api/runs/run-b", second.detail);
    expect(hook.result.current.selectedId).toBe("run-b");
    expect(
      (http.pending("/api/runs/missing").options.signal as AbortSignal).aborted,
    ).toBe(true);
  });
  it("handles an empty registry and blocked optional browser storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const { result, socket } = await mount([]);
    expect(result.current).toMatchObject({
      selectedId: null,
      detail: null,
      runs: [],
      loading: false,
    });
    socket.reply({ type: "runs", ...runList([first.detail]) });
    await http.reply("/api/runs/run-a", first.detail);
    expect(result.current.detail).toEqual(first.detail);
  });
  it("receives capacity and queue allocation updates without issuing commands", async () => {
    const { result, socket } = await mount();
    const capacity = {
      maxRuns: 2,
      maxEvaluationWorkers: 4,
      allocatedWorkers: 4,
    };
    const queued = changed(first.detail, {
      status: "queued",
      queuePosition: 1,
    });
    socket.reply({
      type: "runs",
      ...runList([queued, second.detail], capacity),
    });
    socket.reply({ type: "run", runId: "run-a", detail: queued });
    expect(result.current.capacity).toEqual(capacity);
    expect(result.current.runs[0].queuePosition).toBe(1);
    expect(result.current.detail?.summary.status).toBe("queued");
    expect(http.mutations).toHaveLength(0);
  });
});

describe("observer-only connection lifecycle", () => {
  it("backs off reconnects, resets after hello, and never pauses VM jobs on disconnect or unmount", async () => {
    const running = changed(first.detail, {
      status: "running",
      workerCount: 1,
    });
    const { result, socket, unmount } = await mount([running]);
    socket.disconnect();
    expect(result.current.connection).toBe("reconnecting");
    expect(result.current.connectionError).toMatch(/VM runs are unaffected/);
    for (const delay of [750, 1500, 3000]) {
      const count = ResearchSocket.instances.length;
      await act(async () => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(ResearchSocket.instances).toHaveLength(count);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(ResearchSocket.instances).toHaveLength(count + 1);
      if (delay !== 3000) ResearchSocket.instances.at(-1)!.fail();
    }
    const restored = ResearchSocket.instances.at(-1)!;
    restored.hello();
    expect(restored.messages).toEqual([{ type: "subscribe", runId: "run-a" }]);
    expect(result.current).toMatchObject({
      connection: "connected",
      connectionError: "",
    });
    expect(result.current.detail?.summary.status).toBe("running");
    restored.disconnect();
    act(() => vi.advanceTimersByTime(750));
    const finalSocket = ResearchSocket.instances.at(-1)!;
    unmount();
    expect(finalSocket.close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(60_000));
    expect(http.mutations).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("polls canonical detail only while offline; manual reconnect disposes the old observer", async () => {
    const { result, socket } = await mount();
    act(() => vi.advanceTimersByTime(5000));
    expect(
      http.requests.filter((r) => r.path === "/api/runs/run-a"),
    ).toHaveLength(1);
    socket.disconnect();
    act(() => result.current.reconnect());
    const replacement = ResearchSocket.instances.at(-1)!;
    expect(replacement).not.toBe(socket);
    expect(socket.onmessage).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    const newer = changed(first.detail, {
      generation: 12,
      updatedAt: "2026-01-01T00:00:12.000Z",
    });
    await http.reply("/api/runs/run-a", newer);
    expect(result.current.detail).toEqual(newer);
    expect(http.mutations).toHaveLength(0);
  });
  it("reports malformed live data and service errors without corrupting the accepted population", async () => {
    const { result, socket } = await mount();
    socket.raw("{ broken");
    expect(result.current.connectionError).toMatch(/Invalid live update/);
    expect(result.current.detail).toEqual(first.detail);
    socket.reply({ type: "error", error: "Worker failed: memory limit." });
    expect(result.current.error).toBe("Worker failed: memory limit.");
    act(() => result.current.clearError());
    expect(result.current.error).toBe("");
  });
  it("recovers from a constructor failure without spawning or stopping a run", async () => {
    ResearchSocket.creationError = new Error("No websocket");
    const hook = renderHook(() => useResearch());
    await http.reply("/api/runs", runList());
    expect(hook.result.current.connection).toBe("reconnecting");
    ResearchSocket.creationError = undefined;
    act(() => vi.advanceTimersByTime(3000));
    ResearchSocket.instances[0].hello();
    expect(hook.result.current.connection).toBe("connected");
    expect(http.mutations).toHaveLength(0);
  });
});

describe("response isolation and canonical state", () => {
  it("does not replace a live detail with the older initial GET", async () => {
    const { result } = renderHook(() => useResearch());
    await http.reply("/api/runs", runList([first.detail]));
    const socket = ResearchSocket.instances[0];
    socket.hello();
    const newer = changed(first.detail, {
      generation: 8,
      updatedAt: "2026-01-01T00:00:08.000Z",
    });
    socket.reply({ type: "run", runId: "run-a", detail: newer });
    await http.reply("/api/runs/run-a", first.detail);
    expect(result.current.detail).toEqual(newer);
  });
  it("aborts selection GETs and ignores both HTTP and live payloads for the previous run", async () => {
    const { result } = renderHook(() => useResearch());
    await http.reply("/api/runs", runList([first.detail, second.detail]));
    const request = http.pending("/api/runs/run-a");
    const socket = ResearchSocket.instances[0];
    socket.hello();
    act(() => result.current.select("run-b"));
    expect(result.current.detail).toBeNull();
    expect((request.options.signal as AbortSignal).aborted).toBe(true);
    await http.reply("/api/runs/run-b", second.detail);
    await act(async () => request.resolve(first.detail));
    socket.reply({ type: "run", runId: "run-a", detail: first.detail });
    expect(result.current.detail).toEqual(second.detail);
    expect(socket.messages.at(-1)).toEqual({
      type: "subscribe",
      runId: "run-b",
    });
  });
  it("keeps newer timestamped run details when an old live payload arrives", async () => {
    const { result, socket } = await mount();
    const newer = changed(first.detail, {
      status: "paused",
      generation: 7,
      updatedAt: "2026-01-01T00:00:09.000Z",
    });
    socket.reply({ type: "run", runId: "run-a", detail: newer });
    socket.reply({
      type: "run",
      runId: "run-a",
      detail: changed(first.detail, { status: "running" }),
    });
    expect(result.current.detail).toEqual(newer);
  });
  it("merges a stale list without rolling a run back after a newer live update", async () => {
    const { result, socket } = await mount();
    const newest = changed(first.detail, {
      generation: 13,
      status: "running",
      updatedAt: "2026-01-01T00:00:13.000Z",
    });
    socket.reply({ type: "run", runId: "run-a", detail: newest });
    act(() => {
      void result.current.refresh();
    });
    await http.reply("/api/runs", runList([first.detail, second.detail]));
    expect(result.current.runs.find((run) => run.id === "run-a")).toEqual(
      newest.summary,
    );
    expect(result.current.detail).toEqual(newest);
  });
  it("does not erase a newly created run when an older registry GET completes last", async () => {
    const { result } = renderHook(() => useResearch());
    const staleList = http.pending("/api/runs");
    const socket = ResearchSocket.instances[0];
    socket.hello();
    socket.reply({ type: "runs", ...runList([first.detail]) });
    await http.reply("/api/runs/run-a", first.detail);
    const created = changed(second.detail, {
      id: "just-created",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    let promise!: Promise<RunDetail>;
    act(() => {
      promise = result.current.create(created.config);
    });
    await http.reply("/api/runs", created, "POST");
    await promise;
    await act(async () => staleList.resolve(runList([first.detail])));
    expect(result.current.selectedId).toBe("just-created");
    expect(result.current.runs.map((run) => run.id)).toContain("just-created");
    expect(result.current.detail).toEqual(created);
  });
  it("does not replace a completed operation with an older pending selected-run GET", async () => {
    const { result } = renderHook(() => useResearch());
    await http.reply("/api/runs", runList([first.detail]));
    const stale = http.pending("/api/runs/run-a");
    let promise!: Promise<RunDetail>;
    act(() => {
      promise = result.current.action("run-a", "start");
    });
    const newer = changed(first.detail, {
      status: "running",
      updatedAt: "2026-01-01T00:00:14.000Z",
    });
    await http.reply("/api/runs/run-a/actions", newer, "POST");
    await promise;
    await act(async () => stale.resolve(first.detail));
    expect(result.current.detail).toEqual(newer);
  });
  it("does not let an older action response overwrite a newer server event", async () => {
    const { result, socket } = await mount();
    let promise!: Promise<RunDetail>;
    act(() => {
      promise = result.current.action("run-a", "start");
    });
    const newest = changed(first.detail, {
      status: "running",
      generation: 5,
      updatedAt: "2026-01-01T00:00:06.000Z",
    });
    socket.reply({ type: "run", runId: "run-a", detail: newest });
    await http.reply(
      "/api/runs/run-a/actions",
      changed(first.detail, { status: "starting" }),
      "POST",
    );
    await promise;
    expect(result.current.detail).toEqual(newest);
    expect(result.current.runs.find((run) => run.id === "run-a")).toEqual(
      newest.summary,
    );
  });
});

describe("explicit HTTP job operations", () => {
  it("waits for actual pause state and surfaces rejected operations without optimistic mutation", async () => {
    const running = changed(first.detail, {
      status: "running",
      workerCount: 1,
    });
    const { result } = await mount([running]);
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.action("run-a", "pause").catch((error) => error);
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.detail).toEqual(running);
    expect(JSON.parse(String(http.mutations[0].options.body))).toEqual({
      action: "pause",
    });
    await http.reply(
      "/api/runs/run-a/actions",
      { error: "Checkpoint disk is full." },
      "POST",
      507,
    );
    await outcome;
    expect(result.current).toMatchObject({
      busy: false,
      error: "Checkpoint disk is full.",
      detail: running,
    });
    act(() => {
      outcome = result.current.action("run-a", "pause");
    });
    const paused = changed(running, {
      status: "paused",
      workerCount: 0,
      updatedAt: "2026-01-01T00:00:10.000Z",
    });
    await http.reply("/api/runs/run-a/actions", paused, "POST");
    await outcome;
    expect(result.current).toMatchObject({
      busy: false,
      error: "",
      detail: paused,
    });
  });
  it("allows only one HTTP mutation at a time, including calls before React rerenders", async () => {
    const { result } = await mount();
    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    act(() => {
      firstPromise = result.current.action("run-a", "step");
      secondPromise = result.current
        .action("run-a", "checkpoint")
        .catch((error) => error);
    });
    expect(http.mutations).toHaveLength(1);
    expect(result.current.busy).toBe(true);
    await http.reply("/api/runs/run-a/actions", first.detail, "POST");
    await firstPromise;
    await secondPromise;
    expect(result.current.busy).toBe(false);
  });
  it.each(["create", "fork", "import"] as const)(
    "accepts the complete %s detail and selects its new persisted identity",
    async (operation) => {
      const { result, socket } = await mount();
      let promise!: Promise<RunDetail>;
      const created = changed(second.detail, {
        id: "new-job",
        parentRunId: operation === "create" ? null : "run-a",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      act(() => {
        promise =
          operation === "create"
            ? result.current.create(second.detail.config, true)
            : operation === "fork"
              ? result.current.fork("run-a")
              : result.current.importCheckpoint(first.checkpoint);
      });
      const path =
        operation === "create"
          ? "/api/runs"
          : operation === "fork"
            ? "/api/runs/run-a/fork"
            : "/api/runs/import";
      const expectedBody =
        operation === "create"
          ? { config: second.detail.config, start: true }
          : operation === "fork"
            ? { start: false }
            : { checkpoint: first.checkpoint, start: false };
      expect(
        JSON.parse(String(http.pending(path, "POST").options.body)),
      ).toEqual(expectedBody);
      await http.reply(path, created, "POST");
      await promise;
      expect(result.current.detail).toEqual(created);
      expect(result.current.selectedId).toBe("new-job");
      expect(result.current.runs[0]).toEqual(created.summary);
      expect(result.current.busy).toBe(false);
      expect(localStorage.getItem(SELECTED_KEY)).toBe("new-job");
      expect(socket.messages.at(-1)).toEqual({
        type: "subscribe",
        runId: "new-job",
      });
    },
  );
  it("does not switch the observer back when an action on the former run completes", async () => {
    const { result } = await mount();
    let promise!: Promise<RunDetail>;
    act(() => {
      promise = result.current.action("run-a", "checkpoint");
    });
    act(() => result.current.select("run-b"));
    await http.reply("/api/runs/run-b", second.detail);
    await http.reply("/api/runs/run-a/actions", first.detail, "POST");
    await promise;
    expect(result.current.selectedId).toBe("run-b");
    expect(result.current.detail).toEqual(second.detail);
  });
});

describe("API deployment failures", () => {
  it("does not corrupt a working registry when a JSON response has the wrong API shape", async () => {
    const { result } = await mount();
    act(() => {
      void result.current.refresh();
    });
    await http.reply("/api/runs", { message: "Not a research registry" });
    expect(result.current.runs).toEqual([
      first.detail.summary,
      second.detail.summary,
    ]);
    expect(result.current.capacity).toEqual(CAPACITY);
    expect(result.current.connectionError).not.toBe("");
  });
  it.each([
    [
      "text/html",
      "<!doctype html><title>Static preview</title>",
      200,
      /no research API/,
    ],
    ["text/html", "upstream unavailable", 502, /Research service unavailable/],
    ["application/json", "{ malformed", 200, /JSON|Unexpected|property/i],
  ] as const)(
    "reports %s HTTP %s instead of pretending an empty registry is a working service",
    async (contentType, body, status, error) => {
      const { result } = renderHook(() => useResearch());
      await act(async () =>
        http.pending("/api/runs").raw(body, contentType, status),
      );
      expect(result.current.loading).toBe(false);
      expect(result.current.connectionError).toMatch(error);
      expect(result.current.runs).toEqual([]);
      expect(http.mutations).toHaveLength(0);
    },
  );
});
