import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { VolumeProps } from "./components/Volume";
import { STORAGE_KEY, type Experiment } from "./experiment";
import { genomeId, PRESETS, simulate, type Simulation } from "./simulation";
import {
  ControlledSocket,
  savedStudy,
  snapshotFor,
} from "./test/controlledSocket";

// Only WebGL and the network boundary are doubles. App, its WebSocket hook,
// rule editor, persistence, diagnostics, and decoded scientific data are real.
const viewport = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./components/Volume", () => ({
  default: (props: VolumeProps) => {
    viewport.render(props);
    return (
      <button onClick={() => props.onLayerSelect?.(7)}>
        Inspect rendered layer seven
      </button>
    );
  },
}));

function currentExperiment(): Experiment {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!);
}
function volumeProps(): VolumeProps & { simulation: Simulation } {
  return viewport.render.mock.calls.at(-1)![0];
}
function settleEdits() {
  act(() => vi.advanceTimersByTime(180));
}
function timeSlider() {
  return screen.getByRole("slider", { name: "Visible time layer" });
}
function controls() {
  fireEvent.click(screen.getByRole("button", { name: "Toggle controls" }));
}
function diagnostics() {
  fireEvent.click(screen.getByRole("button", { name: "Toggle diagnostics" }));
  return screen.getByRole("complementary", { name: "Diagnostics" });
}
function metric(name: string): string | null {
  return within(
    screen.getByRole("complementary", { name: "Diagnostics" }),
  ).getByText(name, { selector: "dt" }).nextElementSibling!.textContent;
}
function uploadFile(text: string, bytes?: number) {
  const file = new File([text], "study.json", { type: "application/json" });
  // jsdom omits File.text, but the same asynchronous browser contract is used.
  Object.defineProperty(file, "text", {
    value: vi.fn().mockResolvedValue(text),
  });
  if (bytes !== undefined)
    Object.defineProperty(file, "size", { value: bytes });
  return file;
}
async function importFile(file?: File) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Import experiment file"), {
      target: { files: file ? [file] : [] },
    });
  });
}
function mountApp(initial?: Experiment | string, ready = true) {
  if (initial !== undefined)
    localStorage.setItem(
      STORAGE_KEY,
      typeof initial === "string" ? initial : JSON.stringify(initial),
    );
  const view = render(<App />);
  const socket = ControlledSocket.instances.at(-1)!;
  if (ready) {
    socket.ready();
    socket.respond();
  }
  return { ...view, socket };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  viewport.render.mockClear();
  ControlledSocket.reset();
  vi.stubGlobal("WebSocket", ControlledSocket);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    },
    close: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
      }),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the minimal VM-backed workbench", () => {
  it("starts with a full viewport, a small toolbar and optional timeline, not decorative content or statistics", () => {
    const { socket } = mountApp(undefined, false);
    expect(
      screen.getByRole("main", { name: "Cellular automaton spacetime" }),
    ).toBeVisible();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Small rules|Collection|Occupied \/ layer|Fitness|Lifetime|State diversity/i,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle controls" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Toggle diagnostics" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Run evolution" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Step evolution" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit rule" })).toBeDisabled();
    expect(timeSlider()).toBeDisabled();
    expect(viewport.render).not.toHaveBeenCalled();
    socket.ready();
    expect(screen.getByRole("status", { name: "VM connected" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Run evolution" }),
    ).toBeDisabled();
    expect(socket.request.type).toBe("evaluate");
    socket.respond();
    expect(currentExperiment()).toEqual({
      version: 1,
      name: "Dendrite",
      genome: PRESETS[0].genome,
      config: { size: 41, steps: 48, seed: "cross", randomSeed: 1729 },
    });
    expect(volumeProps()).toMatchObject({
      simulation: simulate(PRESETS[0].genome, currentExperiment().config),
      visibleLayers: 48,
      annotations: false,
      autoRotate: false,
    });
    expect(screen.getByRole("button", { name: "Run evolution" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Step evolution" }),
    ).toBeEnabled();
  });

  it("opens one drawer at a time and derives hidden diagnostics from the accepted VM snapshot", () => {
    const { socket } = mountApp(savedStudy());
    controls();
    expect(
      screen.getByRole("complementary", { name: "Controls" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Objective" })).toHaveValue(
      "complexity",
    );
    fireEvent.click(screen.getByText("Evolution", { selector: "summary" }));
    expect(
      screen.getByRole("combobox", { name: "Objective" }),
    ).not.toBeVisible();
    fireEvent.click(screen.getByText("Evolution", { selector: "summary" }));
    expect(screen.getByRole("combobox", { name: "Objective" })).toBeVisible();
    const panel = diagnostics();
    expect(
      screen.queryByRole("complementary", { name: "Controls" }),
    ).not.toBeInTheDocument();
    expect(metric("Execution")).toBe("VM / thread 7");
    expect(metric("Epoch")).toBe("0");
    expect(metric("Fitness")).toBe(
      snapshotFor(socket.request).fitness.toFixed(5),
    );
    expect(metric("Rule")).toBe(genomeId(savedStudy().genome));
    expect(metric("Activity")).toBe(
      volumeProps().simulation.activity.toFixed(5),
    );
    expect(metric("State diversity")).toBe(
      volumeProps().simulation.diversity.toFixed(5),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Fitness", { selector: "dt" }),
    ).not.toBeInTheDocument();
  });

  it.each(PRESETS)(
    "selects $name as a rule and seed while retaining the requested dimensions",
    (preset) => {
      const { socket } = mountApp(savedStudy());
      controls();
      fireEvent.change(screen.getByRole("combobox", { name: "Grid size" }), {
        target: { value: "33" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Time depth" }), {
        target: { value: "32" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Rule preset" }), {
        target: { value: preset.id },
      });
      const expected = {
        version: 1,
        name: preset.name,
        genome: preset.genome,
        config: { size: 33, steps: 32, seed: preset.seed, randomSeed: 2024 },
      };
      expect(currentExperiment()).toEqual(expected);
      settleEdits();
      expect(socket.request).toMatchObject({
        type: "evaluate",
        genome: preset.genome,
        config: expected.config,
      });
      socket.respond();
      expect(volumeProps().simulation).toEqual(
        simulate(preset.genome, expected.config),
      );
      expect(timeSlider()).toHaveValue("32");
    },
  );

  it("restores an exact custom rule and seed instead of replacing it with a preset", () => {
    const saved = {
      ...savedStudy(),
      config: { ...savedStudy().config, seed: "islands" as const },
    };
    const { socket } = mountApp(saved);
    controls();
    expect(currentExperiment()).toEqual(saved);
    expect(socket.request).toMatchObject({
      genome: saved.genome,
      config: saved.config,
    });
    expect(screen.getByRole("combobox", { name: "Rule preset" })).toHaveValue(
      "custom",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Initial seed" }),
    ).toHaveValue(2024);
  });

  it.each(["{", JSON.stringify({ ...savedStudy(), config: { size: 999999 } })])(
    "recovers corrupt persisted state without leaving the VM unavailable: %s",
    (raw) => {
      mountApp(raw);
      expect(currentExperiment().genome).toEqual(PRESETS[0].genome);
      expect(
        screen.getByRole("button", { name: "Run evolution" }),
      ).toBeEnabled();
    },
  );

  it("remains usable when browser persistence is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const { socket } = mountApp();
    controls();
    fireEvent.change(screen.getByRole("combobox", { name: "Rule preset" }), {
      target: { value: "pagoda" },
    });
    settleEdits();
    socket.respond();
    expect(volumeProps().simulation).toEqual(
      simulate(PRESETS[1].genome, socket.request.config),
    );
  });
});

describe("actual VM commands and revision isolation", () => {
  it("sends Step, Start and Pause, receives epochs, and never accepts a late run result after pause", () => {
    const { socket } = mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Step evolution" }));
    expect(socket.request.type).toBe("step");
    expect(
      screen.getByRole("button", { name: "Run evolution" }),
    ).toBeDisabled();
    expect(timeSlider()).toBeDisabled();
    const step = socket.respond();
    diagnostics();
    expect(metric("Epoch")).toBe("1");
    expect(metric("Fitness")).toBe(step.fitness.toFixed(5));
    expect(
      screen.getByRole("img", {
        name: "Best fitness across evolutionary epochs",
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
    expect(socket.request).toMatchObject({
      type: "start",
      epoch: 1,
      randomSeed: step.randomSeed,
      genome: step.genome,
    });
    const pendingRun = snapshotFor(socket.request);
    expect(
      screen.getByRole("button", { name: "Step evolution" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play time" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pause evolution" }));
    expect(socket.latest.type).toBe("pause");
    socket.reply(pendingRun);
    expect(metric("Epoch")).toBe("1");
    expect(currentExperiment().genome).toEqual(step.genome);
    expect(screen.getByRole("button", { name: "Run evolution" })).toBeEnabled();
    expect(timeSlider()).toBeEnabled();
  });

  it.each([
    [
      "seed pattern",
      () =>
        fireEvent.change(
          screen.getByRole("combobox", { name: "Seed pattern" }),
          { target: { value: "islands" } },
        ),
    ],
    [
      "initial seed",
      () =>
        fireEvent.change(
          screen.getByRole("spinbutton", { name: "Initial seed" }),
          { target: { value: "991" } },
        ),
    ],
    [
      "grid",
      () =>
        fireEvent.change(screen.getByRole("combobox", { name: "Grid size" }), {
          target: { value: "33" },
        }),
    ],
    [
      "depth",
      () =>
        fireEvent.change(screen.getByRole("combobox", { name: "Time depth" }), {
          target: { value: "32" },
        }),
    ],
    [
      "objective",
      () =>
        fireEvent.change(screen.getByRole("combobox", { name: "Objective" }), {
          target: { value: "growth" },
        }),
    ],
    [
      "mutation",
      () =>
        fireEvent.change(
          screen.getByRole("slider", { name: "Mutation rate" }),
          { target: { value: ".2" } },
        ),
    ],
    [
      "search seed",
      () =>
        fireEvent.change(
          screen.getByRole("spinbutton", { name: "Search seed" }),
          { target: { value: "42" } },
        ),
    ],
    [
      "source",
      () =>
        fireEvent.change(
          screen.getByRole("combobox", { name: "Rule preset" }),
          { target: { value: "dendrite" } },
        ),
    ],
    [
      "reset",
      () =>
        fireEvent.click(screen.getByRole("button", { name: "Reset search" })),
    ],
  ] as const)(
    "stops the previous run and rejects its late result when %s changes",
    (_label, change) => {
      const { socket } = mountApp(savedStudy());
      fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
      const stale = socket.respond();
      controls();
      change();
      expect(socket.latest.type).toBe("pause");
      const replacement = currentExperiment();
      socket.reply({ ...stale, epoch: 899 });
      expect(currentExperiment()).toEqual(replacement);
      settleEdits();
      expect(socket.request.type).toBe("evaluate");
      expect(socket.request.id).toBeGreaterThan(stale.id);
      expect(
        screen.queryByRole("button", { name: "Pause evolution" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Run evolution" }),
      ).toBeDisabled();
      socket.reply({ ...stale, epoch: 900 });
      socket.reply({ type: "error", id: stale.id, error: "old failure" });
      expect(currentExperiment()).toEqual(replacement);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      socket.respond();
      diagnostics();
      expect(metric("Epoch")).toBe("0");
      expect(
        screen.getByRole("button", { name: "Run evolution" }),
      ).toBeEnabled();
      expect(volumeProps().simulation).toEqual(
        simulate(replacement.genome, replacement.config),
      );
    },
  );

  it("supports Space and period outside forms, and leaves native form/dialog keys alone", () => {
    const { socket } = mountApp(savedStudy());
    fireEvent.keyDown(document.body, { key: ".", code: "Period" });
    expect(socket.request.type).toBe("step");
    socket.respond();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(socket.request.type).toBe("start");
    socket.respond();
    const sent = socket.commands.length;
    fireEvent.keyDown(timeSlider(), { key: " ", code: "Space" });
    expect(socket.commands).toHaveLength(sent);
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(socket.latest.type).toBe("pause");
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    const beforeDialogKey = socket.commands.length;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: " ", code: "Space" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: ".", code: "Period" });
    expect(socket.commands).toHaveLength(beforeDialogKey);
  });

  it("surfaces worker errors, can dismiss/retry, and reconnects a failed transport", () => {
    const { socket } = mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
    socket.reply({
      type: "error",
      id: socket.request.id,
      error: "Search budget exhausted.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Search budget exhausted.",
    );
    expect(currentExperiment()).toEqual(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Step evolution" }));
    socket.respond();
    socket.disconnect();
    expect(
      screen.getByRole("button", { name: "Run evolution" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const next = ControlledSocket.instances.at(-1)!;
    expect(socket.close).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Step evolution" }),
    ).toBeDisabled();
    next.ready();
    next.respond();
    expect(screen.getByRole("status", { name: "VM connected" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run evolution" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("time and rendering are optional local views of accepted data", () => {
  it("plays, pauses and stops at the last layer without requesting VM computation", () => {
    const { socket, unmount } = mountApp(savedStudy());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    expect(timeSlider()).toHaveValue("1");
    act(() => vi.advanceTimersByTime(130));
    expect(volumeProps().visibleLayers).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Pause time" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(timeSlider()).toHaveValue("2");
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    act(() => vi.advanceTimersByTime(24 * 130));
    expect(timeSlider()).toHaveValue("24");
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.commands).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    unmount();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scrubs and selects a rendered layer while diagnostics report that exact layer's occupancy", () => {
    mountApp(savedStudy());
    diagnostics();
    fireEvent.change(timeSlider(), { target: { value: "5" } });
    expect(volumeProps().visibleLayers).toBe(5);
    expect(metric("Occupied / layer")).toBe(
      String(volumeProps().simulation.population[4]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect rendered layer seven" }),
    );
    expect(timeSlider()).toHaveValue("8");
    expect(metric("Occupied / layer")).toBe(
      String(volumeProps().simulation.population[7]),
    );
  });

  it("hides timeline, changes view options and resets camera without modifying the experiment or asking the VM", () => {
    const { socket } = mountApp(savedStudy());
    const simulation = volumeProps().simulation;
    controls();
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Palette" }), {
      target: { value: "ember" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Rendering" }), {
      target: { value: "points" },
    });
    for (const label of [
      "Dither / grain",
      "Rotate",
      "Reference grid",
      "Timeline",
    ])
      fireEvent.click(screen.getByRole("checkbox", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(volumeProps()).toMatchObject({
      mode: "points",
      palette: "ember",
      grain: false,
      autoRotate: true,
      annotations: true,
      resetKey: 1,
    });
    expect(volumeProps().simulation).toBe(simulation);
    expect(currentExperiment()).toEqual(savedStudy());
    expect(socket.commands).toHaveLength(1);
    expect(
      screen.queryByRole("slider", { name: "Visible time layer" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Timeline" }));
    expect(timeSlider()).toBeVisible();
  });
});

describe("portable experiments and the compact rule draft", () => {
  it("imports an exact experiment, stops an active run and ignores its stale result", async () => {
    const { socket } = mountApp();
    fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
    const stale = snapshotFor(socket.request);
    const imported = {
      ...savedStudy(),
      name: "<img src=x onerror=alert(1)> is a literal name",
    };
    await importFile(uploadFile(JSON.stringify(imported)));
    expect(currentExperiment()).toEqual(imported);
    expect(screen.getByLabelText("Import experiment file")).toHaveValue("");
    expect(socket.latest.type).toBe("pause");
    settleEdits();
    expect(socket.request).toMatchObject({
      type: "evaluate",
      genome: imported.genome,
      config: imported.config,
      epoch: 0,
    });
    socket.reply(stale);
    expect(currentExperiment()).toEqual(imported);
    socket.respond();
    expect(timeSlider()).toHaveValue("24");
    expect(volumeProps().simulation).toEqual(
      simulate(imported.genome, imported.config),
    );
    expect(
      screen.queryByRole("img", { name: /literal name/ }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["invalid JSON", "{", /JSON|Unexpected|Expected/i],
    [
      "unsupported version",
      JSON.stringify({ ...savedStudy(), version: 2 }),
      /valid 45-gene/,
    ],
    [
      "invalid rule",
      JSON.stringify({ ...savedStudy(), genome: Array(45).fill(5) }),
      /valid 45-gene/,
    ],
    [
      "unsupported config",
      JSON.stringify({
        ...savedStudy(),
        config: { ...savedStudy().config, size: 500 },
      }),
      /settings are not supported/,
    ],
  ])(
    "rejects %s without sending new work or replacing the experiment",
    async (_label, text, message) => {
      const { socket } = mountApp(savedStudy());
      await importFile(uploadFile(String(text)));
      expect(screen.getByRole("alert")).toHaveTextContent(message as RegExp);
      expect(currentExperiment()).toEqual(savedStudy());
      expect(socket.commands).toHaveLength(1);
    },
  );

  it("rejects an oversized file before reading it and does nothing for a cancelled picker", async () => {
    const { socket } = mountApp(savedStudy());
    const file = uploadFile(JSON.stringify(savedStudy()), 100_001);
    await importFile(file);
    expect(file.text).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("File exceeds 100 KB.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    await importFile();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentExperiment()).toEqual(savedStudy());
    expect(socket.commands).toHaveLength(1);
  });

  it("exports the exact accepted experiment with its rule filename and releases the download URL", async () => {
    mountApp(savedStudy());
    const createObjectURL = vi.fn((_blob: Blob) => "blob:experiment-download");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const downloads: { href: string; filename: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, filename: this.download });
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save experiment" }));
    expect(downloads).toEqual([
      {
        href: "blob:experiment-download",
        filename: `polyp-${genomeId(savedStudy().genome)}.json`,
      },
    ]);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/json");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:experiment-download");
    vi.useRealTimers();
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(savedStudy());
    expect(text).toBe(JSON.stringify(currentExperiment(), null, 2));
  });

  it("edits a private 45-gene draft, keeps empty void quiescent and applies one new rule", () => {
    const { socket } = mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(socket.latest.type).toBe("pause");
    const dialog = screen.getByRole("dialog", { name: "Rule" });
    expect(
      within(dialog).getAllByRole("button", {
        name: /^State \d, \d neighbors:/,
      }),
    ).toHaveLength(45);
    expect(
      within(dialog).getByRole("button", {
        name: "State 0, 0 neighbors: next state 0",
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "State 0, 1 neighbors: next state 1",
      }),
    );
    expect(
      within(dialog).getByRole("button", {
        name: "State 0, 1 neighbors: next state 2",
      }),
    ).toBeVisible();
    expect(currentExperiment()).toEqual(savedStudy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const genome = [...savedStudy().genome];
    genome[1] = 2;
    expect(currentExperiment()).toEqual({
      ...savedStudy(),
      genome,
      name: "Custom",
    });
    settleEdits();
    expect(socket.request).toMatchObject({
      type: "evaluate",
      genome,
      epoch: 0,
    });
    socket.respond();
    expect(volumeProps().simulation).toEqual(
      simulate(genome, savedStudy().config),
    );
  });

  it("discards cancelled drafts and pauses a live run before opening the editor", () => {
    const { socket } = mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
    const stale = socket.respond();
    const accepted = currentExperiment();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(socket.latest.type).toBe("pause");
    socket.reply({ ...stale, genome: PRESETS[0].genome });
    const originalGene = `State 0, 1 neighbors: next state ${accepted.genome[1]}`;
    fireEvent.click(screen.getByRole("button", { name: originalGene }));
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(currentExperiment()).toEqual(accepted);
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(screen.getByRole("button", { name: originalGene })).toBeVisible();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(currentExperiment()).toEqual(accepted);
  });
});
