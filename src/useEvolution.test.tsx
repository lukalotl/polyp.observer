import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSimulation, useEvolution } from "./useEvolution";
import { PRESETS, simulate } from "./simulation";
import {
  ControlledSocket,
  savedStudy,
  snapshotFor,
} from "./test/controlledSocket";

beforeEach(() => {
  vi.useFakeTimers();
  ControlledSocket.reset();
  vi.stubGlobal("WebSocket", ControlledSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function settleEdits() {
  act(() => vi.advanceTimersByTime(180));
}

function mount(ready = true) {
  const hook = renderHook(() => useEvolution(savedStudy()));
  const socket = ControlledSocket.instances.at(-1)!;
  if (ready) {
    socket.ready();
    socket.respond();
  }
  return { ...hook, socket };
}

describe("VM connection and wire snapshots", () => {
  it("waits for the VM worker handshake, then requests evaluation without running science in the browser", () => {
    const { result, socket } = mount(false);
    expect(new URL(socket.url).pathname).toBe("/api/evolution");
    expect(new URL(socket.url).protocol).toBe("ws:");
    expect(result.current).toMatchObject({
      connection: "connecting",
      pending: true,
      simulation: null,
      execution: null,
      running: false,
    });
    act(() => {
      result.current.start();
      result.current.step();
    });
    expect(socket.send).not.toHaveBeenCalled();
    socket.ready();
    expect(result.current.connection).toBe("ready");
    expect(socket.request).toMatchObject({
      type: "evaluate",
      genome: savedStudy().genome,
      config: savedStudy().config,
      objective: "complexity",
      mutationRate: 0.08,
      randomSeed: 1729,
      epoch: 0,
    });
    expect(result.current.pending).toBe(true);
    const message = socket.respond();
    expect(result.current.simulation).toEqual(
      simulate(savedStudy().genome, savedStudy().config),
    );
    expect(result.current).toMatchObject({
      pending: false,
      running: false,
      epoch: 0,
      score: message.fitness,
      history: [message.fitness],
      execution: { kind: "node:worker_threads", threadId: 7 },
    });
    expect(
      result.current.simulation!.layers.every(
        (layer) => layer instanceof Uint8Array,
      ),
    ).toBe(true);
  });

  it("decodes every base64 cell and preserves measured metadata exactly", () => {
    const { socket } = mount(false);
    socket.ready();
    const message = snapshotFor(socket.request);
    expect(decodeSimulation(message.simulation)).toEqual(
      simulate(savedStudy().genome, savedStudy().config),
    );
    expect(() =>
      decodeSimulation({ ...message.simulation, layers: [btoa("short")] }),
    ).toThrow("Invalid VM layer size");
    expect(() =>
      decodeSimulation({ ...message.simulation, layers: ["%invalid"] }),
    ).toThrow();
  });

  it("steps exactly once, resumes from the accepted genome, epoch and NEXT search seed", () => {
    const { result, socket } = mount();
    act(() => {
      result.current.step();
    });
    expect(result.current).toMatchObject({ pending: true, running: false });
    expect(socket.request.type).toBe("step");
    const step = socket.respond();
    expect(result.current).toMatchObject({
      epoch: 1,
      pending: false,
      running: false,
      score: step.fitness,
    });
    expect(result.current.history).toHaveLength(2);
    act(() => {
      result.current.start();
    });
    expect(socket.request).toMatchObject({
      type: "start",
      genome: step.genome,
      epoch: 1,
      randomSeed: step.randomSeed,
    });
    expect(result.current).toMatchObject({ running: true, pending: true });
    const first = socket.respond();
    const second = snapshotFor({
      ...socket.request,
      genome: first.genome,
      epoch: first.epoch,
      randomSeed: first.randomSeed,
    });
    socket.reply(second);
    expect(result.current).toMatchObject({
      epoch: 3,
      running: true,
      pending: false,
      score: second.fitness,
    });
    expect(result.current.history).toHaveLength(4);
    expect(socket.commands).toHaveLength(3); // Continuous computation belongs to the server, no browser loop.
    act(() => {
      result.current.pause();
    });
    expect(socket.latest).toMatchObject({ type: "pause" });
    expect(socket.latest.id).toBeGreaterThan(second.id);
    const paused = result.current;
    socket.reply({ ...second, epoch: 999, running: true });
    socket.reply({ type: "error", id: second.id, error: "obsolete" });
    expect(result.current).toBe(paused);
    socket.reply({ type: "paused", id: socket.latest.id });
    expect(result.current).toMatchObject({
      epoch: 3,
      running: false,
      pending: false,
      error: "",
    });
  });

  it.each([
    ["seed", { config: { ...savedStudy().config, seed: "islands" as const } }],
    [
      "environment",
      { config: { ...savedStudy().config, size: 33, steps: 32 } },
    ],
    ["rule source", { genome: [...PRESETS[2].genome], name: "Imported rule" }],
  ])(
    "replaces %s atomically, cancels the old revision and rejects all its late messages",
    (_label, update) => {
      const { result, socket } = mount();
      act(() => {
        result.current.start();
      });
      const stale = snapshotFor(socket.request);
      socket.reply(stale);
      const replacement = { ...savedStudy(), ...update };
      act(() => result.current.replace(replacement));
      expect(socket.latest.type).toBe("pause");
      socket.reply(stale);
      expect(result.current.experiment).toEqual(replacement);
      settleEdits();
      expect(socket.request).toMatchObject({
        type: "evaluate",
        genome: replacement.genome,
        config: replacement.config,
        epoch: 0,
        randomSeed: 1729,
      });
      expect(socket.request.id).toBeGreaterThan(stale.id);
      expect(result.current).toMatchObject({
        experiment: replacement,
        pending: true,
        running: false,
        epoch: 0,
        score: null,
        history: [],
      });
      socket.reply(stale);
      socket.reply({ type: "paused", id: stale.id });
      socket.reply({ type: "error", id: stale.id, error: "old worker failed" });
      expect(result.current).toMatchObject({
        experiment: replacement,
        pending: true,
        running: false,
        epoch: 0,
        score: null,
        history: [],
        error: "",
      });
      socket.respond();
      expect(result.current.simulation).toEqual(
        simulate(replacement.genome, replacement.config),
      );
    },
  );

  it("configures objective, mutation and search seed separately from the initial-condition seed; reset is reproducible", () => {
    const { result, socket } = mount();
    act(() =>
      result.current.configure({
        objective: "growth",
        mutationRate: 0.2,
        randomSeed: 90210,
      }),
    );
    settleEdits();
    expect(socket.request).toMatchObject({
      type: "evaluate",
      objective: "growth",
      mutationRate: 0.2,
      randomSeed: 90210,
      config: { randomSeed: 2024 },
    });
    socket.respond();
    act(() => {
      result.current.step();
    });
    const first = socket.respond();
    act(() => result.current.reset());
    settleEdits();
    expect(socket.request).toMatchObject({
      type: "evaluate",
      genome: first.genome,
      epoch: 0,
      randomSeed: 90210,
    });
    expect(result.current).toMatchObject({
      epoch: 0,
      score: null,
      history: [],
      settings: { objective: "growth", mutationRate: 0.2, randomSeed: 90210 },
    });
  });

  it("uses the latest replacement when changed before the VM becomes ready", () => {
    const { result, socket } = mount(false);
    const replacement = {
      ...savedStudy(),
      name: "Changed before connect",
      genome: [...PRESETS[2].genome],
    };
    act(() => {
      result.current.replace(replacement);
      result.current.configure({ randomSeed: 42 });
    });
    expect(socket.send).not.toHaveBeenCalled();
    socket.ready();
    expect(socket.request).toMatchObject({
      type: "evaluate",
      genome: replacement.genome,
      randomSeed: 42,
    });
    socket.respond();
    expect(result.current.experiment).toEqual(replacement);
  });

  it("coalesces rapid parameter edits into one evaluation, pausing a live run immediately", () => {
    const { result, socket } = mount();
    act(() => {
      result.current.start();
    });
    const old = socket.respond();
    const before = socket.commands.length;
    for (let seed = 1; seed <= 30; seed++) {
      act(() =>
        result.current.configure({
          randomSeed: seed,
          mutationRate: seed / 100,
        }),
      );
    }
    expect(socket.commands.slice(before)).toEqual([
      { type: "pause", id: expect.any(Number) },
    ]);
    expect(result.current).toMatchObject({
      running: false,
      pending: true,
      epoch: 0,
      history: [],
      settings: { randomSeed: 30, mutationRate: 0.3 },
    });
    socket.reply(old);
    expect(result.current.epoch).toBe(0);
    act(() => vi.advanceTimersByTime(179));
    expect(socket.commands).toHaveLength(before + 1);
    act(() => vi.advanceTimersByTime(1));
    expect(socket.commands).toHaveLength(before + 2);
    expect(socket.request).toMatchObject({
      type: "evaluate",
      randomSeed: 30,
      mutationRate: 0.3,
      config: { randomSeed: 2024 },
      epoch: 0,
    });
    socket.respond();
    expect(result.current.pending).toBe(false);
  });

  it("cancels pending parameter timers on unmount and never sends through a disposed socket", () => {
    const { result, socket, unmount } = mount();
    act(() => result.current.configure({ objective: "growth" }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(socket.commands).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("caps genuine accepted epoch history at 256 points", () => {
    const { result, socket } = mount();
    act(() => {
      result.current.start();
    });
    const message = snapshotFor(socket.request);
    for (let epoch = 1; epoch <= 260; epoch++)
      socket.reply({ ...message, epoch, fitness: epoch / 1000 });
    expect(result.current.history).toHaveLength(256);
    expect(result.current.history[0]).toBe(0.005);
    expect(result.current.history.at(-1)).toBe(0.26);
  });
});

describe("socket lifecycle and worker failures", () => {
  it("shows a scoped worker error, preserves the experiment and can retry", () => {
    const { result, socket } = mount();
    act(() => {
      result.current.start();
    });
    socket.reply({
      type: "error",
      id: socket.request.id,
      error: "Search budget exhausted.",
    });
    expect(result.current).toMatchObject({
      connection: "ready",
      running: false,
      pending: false,
      experiment: savedStudy(),
      error: "Search budget exhausted.",
    });
    act(() => {
      result.current.step();
    });
    expect(result.current.error).toBe("");
    socket.respond();
    expect(result.current.epoch).toBe(1);
  });

  it("reconnects with the latest experiment, disposes the old socket and ignores messages from that transport", () => {
    const { result, socket, unmount } = mount();
    act(() => {
      result.current.step();
    });
    const accepted = socket.respond();
    socket.disconnect();
    expect(result.current).toMatchObject({
      connection: "disconnected",
      pending: false,
      running: false,
      error: "VM disconnected.",
    });
    act(() => result.current.reconnect());
    const next = ControlledSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    expect(socket.close).toHaveBeenCalledOnce();
    socket.reply({ ...accepted, epoch: 300, running: true });
    socket.ready();
    expect(result.current).toMatchObject({
      connection: "connecting",
      epoch: 1,
    });
    next.ready();
    expect(next.request).toMatchObject({
      genome: accepted.genome,
      epoch: 1,
      randomSeed: accepted.randomSeed,
    });
    next.respond();
    expect(result.current).toMatchObject({
      connection: "ready",
      epoch: 1,
      error: "",
    });
    unmount();
    expect(next.close).toHaveBeenCalledOnce();
    next.reply(accepted); // Disposed callbacks must not restart work.
    expect(next.commands).toHaveLength(1);
  });

  it("retains a specific VM worker error when the socket then closes", () => {
    const { result, socket } = mount();
    socket.reply({ type: "error", error: "VM worker limit reached." });
    socket.disconnect();
    expect(result.current).toMatchObject({
      connection: "disconnected",
      error: "VM worker limit reached.",
    });
  });

  it("invalidates in-flight work as soon as the transport disconnects", () => {
    const { result, socket } = mount();
    act(() => {
      result.current.start();
    });
    const stale = snapshotFor(socket.request);
    const accepted = result.current.experiment;
    socket.fail();
    socket.reply(stale);
    expect(result.current).toMatchObject({
      connection: "disconnected",
      running: false,
      pending: false,
      epoch: 0,
      experiment: accepted,
    });
  });

  it.each(["construction", "send", "runtime"] as const)(
    "handles a synchronous/transport %s failure without discarding the rule",
    (kind) => {
      if (kind === "construction")
        ControlledSocket.creationError = new Error("Socket policy blocked");
      const hook = renderHook(() => useEvolution(savedStudy()));
      const socket = ControlledSocket.instances.at(-1);
      if (kind === "send") {
        socket!.sendError = new Error("Socket closed");
        socket!.ready();
      }
      if (kind === "runtime") socket!.fail();
      expect(hook.result.current).toMatchObject({
        connection: "disconnected",
        running: false,
        pending: false,
        experiment: savedStudy(),
      });
      expect(hook.result.current.error).toMatch(/VM connection/);
    },
  );

  it.each([
    "malformed JSON",
    "invalid worker",
    "invalid base64",
    "wrong layer size",
  ])("disconnects on %s rather than rendering corrupt VM data", (kind) => {
    const { result, socket } = mount(false);
    if (kind === "malformed JSON") socket.raw("{");
    if (kind === "invalid worker")
      socket.reply({
        type: "ready",
        execution: { kind: "node:worker_threads", threadId: 0 },
      });
    if (kind === "invalid base64" || kind === "wrong layer size") {
      socket.ready();
      const message = snapshotFor(socket.request);
      message.simulation.layers[0] =
        kind === "invalid base64" ? "%invalid" : btoa("short");
      socket.reply(message);
    }
    expect(result.current).toMatchObject({
      connection: "disconnected",
      pending: false,
      running: false,
      simulation: null,
      error: "Invalid response from VM worker.",
    });
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
