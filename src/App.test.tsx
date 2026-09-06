import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VolumeProps } from "./components/Volume";
import { STORAGE_KEY, type Experiment } from "./experiment";
import {
  fitness,
  genomeId,
  PRESETS,
  simulate,
  type EvolutionResult,
  type Simulation,
} from "./simulation";

// Keep the real cellular automaton, config, persistence, charts and controls.
// Only the expensive WebGL boundary and asynchronous browser worker are doubles.
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

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static creationError: Error | undefined;
  static sendError: Error | undefined;
  onmessage:
    | ((
        event: MessageEvent<{ result?: EvolutionResult; error?: string }>,
      ) => void)
    | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn((_message: unknown) => {
    if (ControlledWorker.sendError) throw ControlledWorker.sendError;
  });
  terminate = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    if (ControlledWorker.creationError) throw ControlledWorker.creationError;
    ControlledWorker.instances.push(this);
  }
  reply(data: { result?: EvolutionResult; error?: string }) {
    act(() => this.onmessage?.({ data } as MessageEvent<typeof data>));
  }
}

const savedStudy = (): Experiment => ({
  version: 1,
  genome: [...PRESETS[1].genome],
  config: { size: 25, steps: 24, seed: "point", randomSeed: 2024 },
  name: "My saved study",
});

function currentSpecimen(): Experiment {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!);
}
function volumeProps(): VolumeProps {
  return viewport.render.mock.calls.at(-1)![0];
}
function timeSlider() {
  return screen.getByRole("slider", { name: "Visible time layer" });
}
function uploadFile(text: string, bytes?: number): File {
  const file = new File([text], "study.json", { type: "application/json" });
  // jsdom does not implement File.text; use the same asynchronous browser contract.
  Object.defineProperty(file, "text", {
    value: vi.fn().mockResolvedValue(text),
  });
  if (bytes !== undefined)
    Object.defineProperty(file, "size", { value: bytes });
  return file;
}
async function importFile(file: File) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Import specimen file"), {
      target: { files: [file] },
    });
  });
}
async function mountApp(initial?: Experiment | string) {
  if (initial !== undefined)
    localStorage.setItem(
      STORAGE_KEY,
      typeof initial === "string" ? initial : JSON.stringify(initial),
    );
  const { default: App } = await import("./App");
  return render(<App />);
}
function openEvolution() {
  fireEvent.click(screen.getByRole("button", { name: /02 Evolution/i }));
}
function startEvolution() {
  openEvolution();
  fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
  return ControlledWorker.instances.at(-1)!;
}
function resultFor(
  genome = PRESETS[2].genome,
  config = savedStudy().config,
): EvolutionResult {
  const simulation = simulate(genome, config);
  return {
    genome: [...genome],
    simulation,
    fitness: fitness(simulation, "complexity"),
    improved: true,
  };
}

beforeEach(() => {
  // App reads localStorage at module initialization. Reload it per test without
  // creating a second React dispatcher alongside Testing Library's renderer.
  vi.resetModules();
  vi.doMock("react", () => React);
  localStorage.clear();
  viewport.render.mockClear();
  ControlledWorker.instances = [];
  ControlledWorker.creationError = undefined;
  ControlledWorker.sendError = undefined;
  vi.stubGlobal("Worker", ControlledWorker);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
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

describe("the observatory: a real rule becomes a reproducible history", () => {
  it("starts with the Dendrite preset and supplies its actual simulation to the renderer", async () => {
    await mountApp();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Small rules.",
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /Dendrite/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Select Dendrite specimen" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Cross" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const saved = currentSpecimen();
    expect(saved).toEqual({
      version: 1,
      name: "Dendrite",
      genome: PRESETS[0].genome,
      config: { size: 41, steps: 48, seed: "cross", randomSeed: 1729 },
    });
    expect(volumeProps().simulation).toEqual(
      simulate(saved.genome, saved.config),
    );
    expect(volumeProps().visibleLayers).toBe(48);
    expect(
      screen.getByRole("img", { name: "Occupied cell population across time" }),
    ).toBeVisible();
  });

  it.each(PRESETS)(
    "selects $name as both a rule and a seed, while retaining chosen dimensions",
    async (preset) => {
      await mountApp(savedStudy());
      fireEvent.change(screen.getByRole("combobox", { name: "World size" }), {
        target: { value: "33" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Time depth" }), {
        target: { value: "32" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: `Select ${preset.name} specimen` }),
      );
      expect(currentSpecimen()).toEqual({
        version: 1,
        genome: preset.genome,
        name: preset.name,
        config: { size: 33, steps: 32, seed: preset.seed, randomSeed: 1729 },
      });
      for (const item of PRESETS)
        expect(
          screen.getByRole("button", { name: `Select ${item.name} specimen` }),
        ).toHaveAttribute("aria-pressed", String(item.id === preset.id));
      expect(volumeProps().simulation).toEqual(
        simulate(preset.genome, currentSpecimen().config),
      );
      expect(timeSlider()).toHaveValue("32");
    },
  );

  it("recomputes a changed seed/environment, resets time, and persists the resulting config", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    fireEvent.click(screen.getByRole("button", { name: "Islands" }));
    fireEvent.change(screen.getByRole("combobox", { name: "World size" }), {
      target: { value: "49" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Time depth" }), {
      target: { value: "64" },
    });
    expect(currentSpecimen().config).toEqual({
      size: 49,
      steps: 64,
      seed: "islands",
      randomSeed: 2024,
    });
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    expect(timeSlider()).toHaveValue("64");
    expect(volumeProps().simulation).toEqual(
      simulate(savedStudy().genome, currentSpecimen().config),
    );
  });

  it("restores a saved rule and custom seed at startup without silently replacing it with a preset", async () => {
    const study = savedStudy();
    study.config.seed = "islands";
    await mountApp(study);
    expect(
      screen.getByRole("heading", { name: /My saved study/ }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "World size" })).toHaveValue(
      "25",
    );
    expect(screen.getByRole("combobox", { name: "Time depth" })).toHaveValue(
      "24",
    );
    expect(screen.getByRole("button", { name: "Islands" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(currentSpecimen()).toEqual(study);
    expect(volumeProps().simulation).toEqual(
      simulate(study.genome, study.config),
    );
    for (const preset of PRESETS)
      expect(
        screen.getByRole("button", { name: `Select ${preset.name} specimen` }),
      ).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    "broken JSON",
    JSON.stringify({ ...savedStudy(), config: { size: 999_999 } }),
  ])("recovers from corrupt local state: %s", async (raw) => {
    await mountApp(raw);
    expect(screen.getByRole("heading", { name: /Dendrite/ })).toBeVisible();
    expect(currentSpecimen().genome).toEqual(PRESETS[0].genome);
  });

  it("remains usable when reading and writing browser storage are blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await mountApp();
    fireEvent.click(
      screen.getByRole("button", { name: "Select Pagoda specimen" }),
    );
    expect(screen.getByRole("heading", { name: /Pagoda/ })).toBeVisible();
    expect(volumeProps().simulation.size).toBe(41);
  });

  it("changes the actual genome on manual mutation, including repeated minimum-rate mutations", async () => {
    await mountApp(savedStudy());
    fireEvent.change(screen.getByRole("slider", { name: /Mutation rate/ }), {
      target: { value: "0.02" },
    });
    for (let repeat = 0; repeat < 8; repeat++) {
      const before = currentSpecimen().genome;
      fireEvent.click(screen.getByRole("button", { name: "Mutate this rule" }));
      const after = currentSpecimen();
      expect(after.genome).not.toEqual(before);
      expect(after.genome[0]).toBe(0);
      expect(after.name).toBe("Mutant form");
      expect(volumeProps().simulation).toEqual(
        simulate(after.genome, after.config),
      );
    }
    expect(screen.getByRole("status")).toHaveTextContent("Rule mutated");
  });

  it("changes render options and camera reset without altering the scientific specimen", async () => {
    await mountApp(savedStudy());
    const before = currentSpecimen();
    const originalSimulation = volumeProps().simulation;
    fireEvent.click(screen.getByRole("button", { name: "ember palette" }));
    fireEvent.click(screen.getByRole("button", { name: "Point rendering" }));
    fireEvent.click(screen.getByRole("switch", { name: "Dither and grain" }));
    fireEvent.click(screen.getByRole("switch", { name: "Slow orbit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(volumeProps()).toMatchObject({
      palette: "ember",
      mode: "points",
      grain: false,
      autoRotate: true,
      resetKey: 1,
    });
    expect(volumeProps().simulation).toBe(originalSimulation);
    expect(currentSpecimen()).toEqual(before);
    expect(
      screen.getByRole("button", { name: "ember palette" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch", { name: "Slow orbit" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("time exploration", () => {
  it("plays from the seed at the end, increments, pauses, and stops at the present", async () => {
    await mountApp(savedStudy());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    expect(timeSlider()).toHaveValue("1");
    expect(volumeProps().visibleLayers).toBe(1);
    act(() => vi.advanceTimersByTime(130));
    expect(timeSlider()).toHaveValue("2");
    fireEvent.click(screen.getByRole("button", { name: "Pause time" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(timeSlider()).toHaveValue("2");
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    act(() => vi.advanceTimersByTime(130 * 24));
    expect(timeSlider()).toHaveValue("24");
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scrubs and inspects a rendered cell using the same zero-based layer and occupancy metrics", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    fireEvent.change(timeSlider(), { target: { value: "5" } });
    expect(volumeProps().visibleLayers).toBe(5);
    expect(
      screen.getByRole("region", { name: "Time explorer" }),
    ).toHaveTextContent("LAYER 04/ 23");
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect rendered layer seven" }),
    );
    expect(timeSlider()).toHaveValue("8");
    const occupied = (volumeProps().simulation as Simulation).population[7];
    expect(
      screen.getByRole("region", { name: "Simulation statistics" }),
    ).toHaveTextContent(`${occupied.toLocaleString("en-US")} cells`);
    expect(
      screen.getByRole("region", { name: "Time explorer" }),
    ).toHaveTextContent("LAYER 07/ 23");
    fireEvent.click(
      screen.getByRole("button", { name: "Show all time layers" }),
    );
    expect(timeSlider()).toHaveValue("24");
  });

  it("announces extinction while retaining its explorable seed history", async () => {
    await mountApp({
      ...savedStudy(),
      genome: Array(45).fill(0),
      name: "Finite form",
    });
    expect(screen.getByText("No occupied cells at this layer.")).toBeVisible();
    fireEvent.change(timeSlider(), { target: { value: "1" } });
    expect(
      screen.queryByText("No occupied cells at this layer."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Simulation statistics" }),
    ).toHaveTextContent("1 cells");
  });

  it("supports Space outside form controls, leaves native control keys alone, and ignores Space in the model dialog", async () => {
    await mountApp(savedStudy());
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(screen.getByRole("button", { name: "Pause time" })).toBeVisible();
    fireEvent.keyDown(timeSlider(), { key: " ", code: "Space" });
    expect(screen.getByRole("button", { name: "Pause time" })).toBeVisible();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "The idea behind it" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: " ", code: "Space" });
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
  });

  it("cleans up the playback interval on unmount", async () => {
    const view = await mountApp(savedStudy());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play time" }));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("portable specimens", () => {
  it("imports a valid custom rule, settings and literal name; resets the upload input and timeline", async () => {
    await mountApp();
    const study = savedStudy();
    study.name = "<img src=x onerror=alert(1)> is only a name";
    fireEvent.change(timeSlider(), { target: { value: "3" } });
    await importFile(uploadFile(JSON.stringify(study)));
    expect(currentSpecimen()).toEqual(study);
    expect(
      screen.getByRole("heading", { name: /is only a name/ }),
    ).toHaveTextContent(study.name);
    expect(
      screen.queryByRole("img", { name: /is only a name/ }),
    ).not.toBeInTheDocument();
    expect(timeSlider()).toHaveValue("24");
    expect(screen.getByRole("status")).toHaveTextContent("Specimen imported.");
    expect(screen.getByLabelText("Import specimen file")).toHaveValue("");
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
    "rejects %s without losing the current specimen",
    async (_label, text, message) => {
      await mountApp(savedStudy());
      const before = currentSpecimen();
      await importFile(uploadFile(text));
      expect(screen.getByRole("status")).toHaveTextContent(message);
      expect(currentSpecimen()).toEqual(before);
      expect(
        screen.getByRole("heading", { name: /My saved study/ }),
      ).toBeVisible();
    },
  );

  it("rejects oversized files before reading them, and a cancelled file picker is a no-op", async () => {
    await mountApp(savedStudy());
    const file = uploadFile(JSON.stringify(savedStudy()), 100_001);
    await importFile(file);
    expect(file.text).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("smaller than 100 KB");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Import specimen file"), {
        target: { files: [] },
      });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(currentSpecimen()).toEqual(savedStudy());
  });

  it("exports the exact portable experiment with a genotype filename and releases its object URL", async () => {
    await mountApp(savedStudy());
    const createObjectURL = vi.fn((_blob: Blob) => "blob:specimen-download");
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
    fireEvent.click(screen.getByRole("button", { name: "Save specimen" }));
    expect(downloads).toEqual([
      {
        href: "blob:specimen-download",
        filename: `polyp-${genomeId(savedStudy().genome)}.json`,
      },
    ]);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/json");
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(savedStudy());
    expect(screen.getByRole("status")).toHaveTextContent("Specimen exported");
    // The browser gets a turn to consume the URL before it is revoked.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1050));
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:specimen-download");
  });
});

describe("worker lifecycle and reproducible evolution", () => {
  it("captures the chosen environment, accepts an epoch, and breeds from the returned rule", async () => {
    await mountApp(savedStudy());
    vi.useFakeTimers();
    const worker = startEvolution();
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.url.pathname).toMatch(/evolution\.worker\.ts$/);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        genome: savedStudy().genome,
        config: savedStudy().config,
        objective: "complexity",
        mutationRate: 0.08,
        randomSeed: expect.any(Number),
      }),
    );
    expect(screen.getByRole("button", { name: "Play time" })).toBeDisabled();
    expect(timeSlider()).toBeDisabled();
    const result = resultFor();
    worker.reply({ result });
    expect(screen.getByRole("heading", { name: /Evolved form/ })).toBeVisible();
    expect(screen.getByText("1 epochs of possibility.")).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "Best fitness across evolutionary epochs",
      }),
    ).toBeVisible();
    expect(currentSpecimen().genome).toEqual(result.genome);
    act(() => vi.advanceTimersByTime(180));
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        genome: result.genome,
        config: savedStudy().config,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause evolution" }));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Play time" })).toBeEnabled();
    act(() => vi.advanceTimersByTime(1000));
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.reply({ result: resultFor(PRESETS[0].genome) });
    expect(currentSpecimen().genome).toEqual(result.genome);
  });

  it.each([
    [
      "seed",
      () => fireEvent.click(screen.getByRole("button", { name: "Cross" })),
    ],
    [
      "world size",
      () =>
        fireEvent.change(screen.getByRole("combobox", { name: "World size" }), {
          target: { value: "33" },
        }),
    ],
    [
      "time depth",
      () =>
        fireEvent.change(screen.getByRole("combobox", { name: "Time depth" }), {
          target: { value: "32" },
        }),
    ],
    [
      "fitness objective",
      () =>
        fireEvent.change(
          screen.getByRole("combobox", { name: "Selection pressure" }),
          { target: { value: "growth" } },
        ),
    ],
    [
      "mutation rate",
      () =>
        fireEvent.change(
          screen.getByRole("slider", { name: /Mutation rate/ }),
          { target: { value: "0.2" } },
        ),
    ],
    [
      "preset",
      () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Select Dendrite specimen" }),
        ),
    ],
    [
      "cleared history",
      () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Clear evolution history" }),
        ),
    ],
  ])(
    "stops and ignores a stale reply after changing %s",
    async (_label, changeEnvironment) => {
      await mountApp(savedStudy());
      vi.useFakeTimers();
      const worker = startEvolution();
      worker.reply({ result: resultFor() });
      changeEnvironment();
      const afterChange = currentSpecimen();
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.reply({ result: resultFor(PRESETS[0].genome) });
      act(() => vi.advanceTimersByTime(1000));
      expect(currentSpecimen()).toEqual(afterChange);
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Run evolution" }),
      ).toBeVisible();
    },
  );

  it("stops the worker when a valid specimen is imported", async () => {
    await mountApp();
    const worker = startEvolution();
    await importFile(uploadFile(JSON.stringify(savedStudy())));
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.reply({ result: resultFor() });
    expect(currentSpecimen()).toEqual(savedStudy());
  });

  it.each(["worker error", "empty response", "runtime error"] as const)(
    "recovers from %s without losing the rule and can restart",
    async (kind) => {
      await mountApp(savedStudy());
      const worker = startEvolution();
      if (kind === "worker error")
        worker.reply({ error: "Search budget exhausted." });
      else if (kind === "empty response") worker.reply({});
      else act(() => worker.onerror?.());
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toBeVisible();
      expect(currentSpecimen()).toEqual(savedStudy());
      fireEvent.click(screen.getByRole("button", { name: "Run evolution" }));
      expect(ControlledWorker.instances).toHaveLength(2);
      expect(
        screen.getByRole("button", { name: "Pause evolution" }),
      ).toBeVisible();
    },
  );

  it.each(["construction", "postMessage"] as const)(
    "recovers from synchronous worker %s failure",
    async (failure) => {
      await mountApp(savedStudy());
      if (failure === "construction")
        ControlledWorker.creationError = new Error(
          "Worker blocked by browser policy",
        );
      else
        ControlledWorker.sendError = new Error(
          "Worker message could not be cloned",
        );
      startEvolution();
      expect(screen.getByRole("status")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Run evolution" }),
      ).toBeVisible();
      expect(currentSpecimen()).toEqual(savedStudy());
      if (failure === "postMessage")
        expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
    },
  );

  it("terminates a pending worker and its scheduled next epoch when the app unmounts", async () => {
    const view = await mountApp(savedStudy());
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const worker = startEvolution();
    worker.reply({ result: resultFor() });
    const scheduledEpoch = timerSpy.mock.calls.findIndex(
      (call) => call[1] === 180,
    );
    expect(scheduledEpoch).toBeGreaterThanOrEqual(0);
    const epochTimer = timerSpy.mock.results[scheduledEpoch].value;
    view.unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(clearSpy).toHaveBeenCalledWith(epochTimer);
    act(() => vi.advanceTimersByTime(1000));
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.reply({ result: resultFor(PRESETS[0].genome) });
    expect(currentSpecimen().genome).toEqual(PRESETS[2].genome);
  });
});

describe("accessible application controls", () => {
  it("exposes current navigation state and returns home without changing the experiment", async () => {
    await mountApp(savedStudy());
    const before = currentSpecimen();
    expect(
      screen.getByRole("button", { name: /01 Observatory/i }),
    ).toHaveAttribute("aria-pressed", "true");
    openEvolution();
    expect(
      screen.getByRole("button", { name: /02 Evolution/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("combobox", { name: "Selection pressure" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Polyp Observer home" }));
    expect(
      screen.queryByRole("combobox", { name: "Selection pressure" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /01 Observatory/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(currentSpecimen()).toEqual(before);
  });

  it("names the model dialog, closes by its explicit button and supports native cancellation", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "The idea behind it" }));
    const dialog = screen.getByRole("dialog", {
      name: /Life as a computation/i,
    });
    expect(dialog).toHaveAttribute("open");
    expect(
      within(dialog).getByRole("link", { name: "Read the original essay" }),
    ).toHaveAttribute("rel", "noreferrer");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close model explanation" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "The idea behind it" }));
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can leave expanded view using Escape", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Expand view" }));
    expect(
      screen.getByRole("button", { name: "Exit expanded view" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("button", { name: "Expand view" })).toBeVisible();
  });
});

describe("editing the 45-gene lookup table", () => {
  it("edits a private draft, keeps void quiescent, cycles outputs, and applies one new rule", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Edit rule genome" }));
    const dialog = screen.getByRole("dialog", {
      name: /A rule for every encounter/i,
    });
    expect(
      within(dialog).getByRole("button", {
        name: "State 0, 0 neighbors: next state 0",
      }),
    ).toBeDisabled();
    expect(
      within(dialog).getAllByRole("button", {
        name: /^State \d, \d neighbors:/,
      }),
    ).toHaveLength(45);
    // Pagoda's birth output starts at 1; editing changes the draft, not the live history.
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
    expect(currentSpecimen()).toEqual(savedStudy());
    fireEvent.keyDown(dialog, { key: " ", code: "Space" });
    expect(screen.getByRole("button", { name: "Play time" })).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Grow this rule" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const expectedGenome = [...savedStudy().genome];
    expectedGenome[1] = 2;
    expect(currentSpecimen()).toEqual({
      ...savedStudy(),
      genome: expectedGenome,
      name: "Custom form",
    });
    expect(volumeProps().simulation).toEqual(
      simulate(expectedGenome, savedStudy().config),
    );
    expect(timeSlider()).toHaveValue("24");
    expect(screen.getByRole("heading", { name: /Custom form/ })).toBeVisible();
  });

  it("discards cancelled edits and reopens a clean draft of the current genome", async () => {
    await mountApp(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Edit rule genome" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "State 0, 1 neighbors: next state 1",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close rule editor" }));
    expect(currentSpecimen()).toEqual(savedStudy());
    fireEvent.click(screen.getByRole("button", { name: "Edit rule genome" }));
    expect(
      screen.getByRole("button", {
        name: "State 0, 1 neighbors: next state 1",
      }),
    ).toBeVisible();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(currentSpecimen()).toEqual(savedStudy());
  });

  it("stops active evolution before editing so stale worker results cannot overwrite the draft", async () => {
    await mountApp(savedStudy());
    const worker = startEvolution();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule genome" }));
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.reply({ result: resultFor() });
    expect(
      screen.getByRole("button", {
        name: "State 0, 1 neighbors: next state 1",
      }),
    ).toBeVisible();
    expect(currentSpecimen()).toEqual(savedStudy());
  });
});
