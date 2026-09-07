import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import App from "./App";
import { incentivesForConfig, presetIncentive } from "./research/incentives";
import RunDialog from "./components/research/RunDialog";
import type { VolumeProps } from "./components/Volume";
import type { RunConfig } from "./research/types";
import { PRESETS } from "./simulation";
import {
  changed,
  installDialog,
  installResearchNetwork,
  previewFor,
  researchFixture,
  ResearchSocket,
  runList,
  smallConfig,
  type ControlledHttp,
} from "./test/researchFixtures";

// App, HTTP serialization, observer hook, dialogs and visualizers are real.
// Only the WebGL boundary is replaced; test fixture CA computation stays here.
const viewport = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./components/Volume", () => ({
  default: (props: VolumeProps) => {
    viewport.render(props);
    return (
      <button onClick={() => props.onLayerSelect?.(3)}>
        Click rendered model
      </button>
    );
  },
}));
let http: ControlledHttp;
let fixture: Awaited<ReturnType<typeof researchFixture>>;
beforeAll(async () => {
  fixture = await researchFixture("run-a", 2, { mutationRate: 0.3 });
});
beforeEach(() => {
  localStorage.clear();
  viewport.render.mockClear();
  http = installResearchNetwork();
  installDialog();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function field(label: string, value: string | number) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value: String(value) },
  });
}
function dialog(initial = smallConfig()) {
  const onCreate = vi.fn().mockResolvedValue(undefined),
    onClose = vi.fn();
  const view = render(
    <RunDialog
      initial={initial}
      maxWorkers={6}
      busy={false}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { ...view, onCreate, onClose };
}
async function submit(name = "Create paused") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("complete, immutable run configuration", () => {
  it("creates, edits, weights, removes and round-trips safe custom incentives", async () => {
    const initial = smallConfig();
    const { onCreate } = dialog(initial);
    expect(
      screen.queryByLabelText("Objective", { exact: true }),
    ).not.toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Add incentive" });
    expect(within(picker).getAllByRole("option")[0]).toHaveValue("new");
    field("Add incentive", "new");
    const editor = screen.getByRole("dialog", {
      name: "New incentive",
    });
    expect(within(editor).getByText("Available variables")).toBeVisible();
    field("Incentive name", "Small and finite");
    field("Math formula", "process.exit()");
    expect(
      within(editor).getByRole("button", {
        name: "Add incentive",
      }),
    ).toBeDisabled();
    expect(within(editor).getByRole("status")).toHaveTextContent(
      /Unsupported character|Unknown/,
    );
    field("Math formula", "extinct * (1 - totalCells / (area * steps))");
    expect(within(editor).getByRole("status")).toHaveTextContent(
      "Valid formula",
    );
    fireEvent.click(
      within(editor).getByRole("button", {
        name: "Add incentive",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "New incentive" }),
    ).not.toBeInTheDocument();
    field("Incentive 2 weight", 3);
    expect(
      screen.getByRole("list", { name: "Scoring incentives" }),
    ).toHaveTextContent("75.0%");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit incentive 2: Small and finite",
      }),
    );
    field("Math formula", "extinct * (1 - occupancy)");
    fireEvent.click(screen.getByRole("button", { name: "Save incentive" }));
    field("Add incentive", "activity");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove incentive 3: Motion" }),
    );
    const expected = [
      ...incentivesForConfig(initial),
      {
        name: "Small and finite",
        expression: "extinct * (1 - occupancy)",
        weight: 3,
      },
    ];
    fireEvent.click(screen.getByLabelText("Edit configuration JSON"));
    expect(
      JSON.parse(
        (screen.getByLabelText("Configuration JSON") as HTMLTextAreaElement)
          .value,
      ).incentives,
    ).toEqual(expected);
    fireEvent.click(screen.getByLabelText("Use parameter fields"));
    await submit();
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ incentives: expected }),
      false,
    );
    expect(initial.incentives).toBeUndefined();
  });
  it("rejects empty or all-disabled incentive lists and cancels a custom edit without changing the run", async () => {
    const { onCreate, onClose } = dialog();
    field("Add incentive", "new");
    field("Incentive name", "Unsaved");
    fireEvent.click(
      screen.getByRole("button", { name: "Close incentive editor" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    field("Incentive 1 weight", 0);
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent(/positive weight/);
    fireEvent.click(
      screen.getByRole("button", { name: /Remove incentive 1:/ }),
    );
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent(/Add 1–16 incentives/);
    expect(onCreate).not.toHaveBeenCalled();
  });
  it("configures soup dimensions and finite scoring with diverse default fixtures", async () => {
    const { onCreate } = dialog();
    field("Seed pattern", "soup");
    expect(screen.getByLabelText("Soup size N")).toHaveValue(9);
    expect(screen.getByLabelText("Training seeds")).toHaveValue(
      "1729, 1730, 1731, 1732",
    );
    field("Soup size N", 6);
    fireEvent.click(
      screen.getByRole("button", { name: /Remove incentive 1:/ }),
    );
    field("Add incentive", "finiteSparse");
    field("Aggregation", "minimum");
    await submit();
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: "soup",
        soupSize: 6,
        incentives: [presetIncentive("finiteSparse")],
        aggregation: "minimum",
        trainingSeeds: [1729, 1730, 1731, 1732],
        validationSeeds: [2718, 2719],
      }),
      false,
    );
  });
  it("preserves explicitly chosen fixture sets when selecting soup", async () => {
    const { onCreate } = dialog();
    field("Training seeds", "15, 16");
    field("Held-out seeds", "99");
    field("Seed pattern", "soup");
    fireEvent.click(
      screen.getByRole("button", { name: /Remove incentive 1:/ }),
    );
    field("Add incentive", "finiteDense");
    await submit();
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        incentives: [presetIncentive("finiteDense")],
        trainingSeeds: [15, 16],
        validationSeeds: [99],
      }),
      false,
    );
  });
  it("defaults both boundary policies on and serializes independent overrides through fields and JSON", async () => {
    const { onCreate } = dialog();
    const spatial = screen.getByLabelText("Disqualify spatial edge contact");
    const horizon = screen.getByLabelText("Disqualify time cutoff contact");
    expect(spatial).toBeChecked();
    expect(horizon).toBeChecked();
    fireEvent.click(spatial);
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        boundaryPolicy: { spatial: false, horizon: true },
      }),
      false,
    );
    fireEvent.click(horizon);
    fireEvent.click(screen.getByLabelText("Edit configuration JSON"));
    expect(
      JSON.parse(
        (screen.getByLabelText("Configuration JSON") as HTMLTextAreaElement)
          .value,
      ).boundaryPolicy,
    ).toEqual({ spatial: false, horizon: false });
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        boundaryPolicy: { spatial: false, horizon: false },
      }),
      false,
    );
  });
  it("submits larger grids and deep scale presets through the real configuration dialog", async () => {
    const { onCreate } = dialog();
    field("Grid size", 513);
    field("CA horizon", 2048);
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 513, steps: 2048 }),
      false,
    );
    field("Simulation scale", "long");
    expect(screen.getByLabelText("Grid size", { exact: true })).toHaveValue(
      127,
    );
    expect(screen.getByLabelText("CA horizon", { exact: true })).toHaveValue(
      65_536,
    );
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 127, steps: 65_536 }),
      false,
    );
  });
  it("edits every configuration family and sends exact scientific parameters once, without modifying its source", async () => {
    const initial = smallConfig();
    const original = structuredClone(initial);
    const { onCreate, onClose } = dialog(initial);
    field("Run name", "Held-out population");
    field("Grid size", 25);
    field("CA horizon", 32);
    field("Seed pattern", "islands");
    field("Training seeds", "11, 22");
    field("Held-out seeds", "33, 44");
    fireEvent.click(
      screen.getByRole("button", { name: /Remove incentive 1:/ }),
    );
    for (const id of ["diversity", "activity", "density", "variation"])
      field("Add incentive", id);
    field("Aggregation", "minimum");
    field("Incentive 1 weight", 0.1);
    field("Incentive 2 weight", 0.2);
    field("Incentive 3 weight", 0.3);
    field("Incentive 4 weight", 0.4);
    field("Population", 16);
    field("Elites", 3);
    field("Selection", "rank");
    field("Tournament size", 5);
    field("Crossover", "onePoint");
    field("Crossover probability", 0.6);
    field("Mutation probability", 0.125);
    field("Immigrant fraction", 0.1);
    field("Search RNG seed", -73);
    field("Initialization", "random");
    field("CPU workers", 3);
    field("Generation limit", 20);
    field("Checkpoint interval (s)", 5);
    field("Archive every N generations", 4);
    field("Retained populations", 12);
    field("Evaluation cache entries", 512);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Resume running jobs after server restart",
      }),
    );
    expect(screen.getByText(/Configurations are immutable/)).toBeVisible();
    expect(
      screen.getByText(/CA timesteps per evaluation, not GA generations/),
    ).toBeVisible();
    await submit("Create & start");
    const expected: RunConfig = {
      ...original,
      name: "Held-out population",
      size: 25,
      steps: 32,
      seed: "islands",
      trainingSeeds: [11, 22],
      validationSeeds: [33, 44],
      aggregation: "minimum",
      incentives: ["diversity", "activity", "density", "variation"].map(
        (id, i) => ({
          ...presetIncentive(id),
          weight: [0.1, 0.2, 0.3, 0.4][i],
        }),
      ),
      populationSize: 16,
      eliteCount: 3,
      selection: "rank",
      tournamentSize: 5,
      crossover: "onePoint",
      crossoverRate: 0.6,
      mutationRate: 0.125,
      immigrantRate: 0.1,
      randomSeed: -73,
      initialization: "random",
      evaluationWorkers: 3,
      maxGenerations: 20,
      checkpointSeconds: 5,
      snapshotEvery: 4,
      retainedSnapshots: 12,
      cacheSize: 512,
      resumeOnRestart: false,
    };
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(expected, true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(initial).toEqual(original);
  });
  it("round-trips JSON and fields without silently changing hidden parameters or the founder genome", async () => {
    const initial = smallConfig();
    const { onCreate } = dialog(initial);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit configuration JSON" }),
    );
    const replacement = {
      ...initial,
      name: "JSON experiment",
      seed: "islands",
      objective: "growth",
      incentives: [presetIncentive("growth")],
      aggregation: "minimum",
      trainingSeeds: [12, 34],
      validationSeeds: [56],
      maxGenerations: 0,
      seedGenome: [...PRESETS[2].genome],
      mutationRate: 0.22,
    };
    field("Configuration JSON", JSON.stringify(replacement));
    fireEvent.click(
      screen.getByRole("button", { name: "Use parameter fields" }),
    );
    expect(screen.getByLabelText("Run name")).toHaveValue("JSON experiment");
    expect(
      screen.queryByLabelText("Objective", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Scoring incentives" }),
    ).toHaveTextContent("Growth");
    expect(screen.getByLabelText("Generation limit")).toHaveValue(0);
    expect(screen.getByText("0 = train until paused.")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit configuration JSON" }),
    );
    expect(
      JSON.parse(
        (screen.getByLabelText("Configuration JSON") as HTMLTextAreaElement)
          .value,
      ),
    ).toEqual(replacement);
    await submit();
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(replacement, false);
  });
  it.each([
    ["Grid size", "24", /Size must be odd/],
    ["CA horizon", "", /Steps must be finite/],
    ["Population", "7", /Population size must be finite/],
    ["Elites", "8", /Elite count must be finite/],
    ["Mutation probability", "1.1", /Mutation rate must be finite/],
    ["Generation limit", "-1", /Maximum generations must be finite/],
    ["Generation limit", "1.5", /Maximum generations must be a safe integer/],
    ["Training seeds", "1,,2", /comma-separated integers/],
    ["Held-out seeds", "1729", /must not overlap/],
  ])(
    "rejects invalid %s (%s) without any request or quiet clamping",
    async (label, value, error) => {
      const { onCreate, onClose } = dialog();
      field(label, value);
      await submit();
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      expect(onCreate).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(http.mutations).toHaveLength(0);
    },
  );
  it("keeps malformed or incomplete JSON editable and preserves validation errors while switching editors", async () => {
    const { onCreate } = dialog();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit configuration JSON" }),
    );
    field("Configuration JSON", "{");
    await submit();
    expect(screen.getByRole("alert")).toBeVisible();
    field("Configuration JSON", JSON.stringify({ name: "Incomplete" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Use parameter fields" }),
    );
    expect(screen.getByLabelText("Configuration JSON")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /exactly the documented fields/,
    );
    expect(onCreate).not.toHaveBeenCalled();
  });
  it("edits the founder in a private 45-locus draft with a locked quiescent gene", async () => {
    const initial = smallConfig();
    const { onCreate } = dialog(initial);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit founder genome" }),
    );
    const rule = screen.getByRole("dialog", { name: "Rule" });
    expect(
      within(rule).getByRole("button", {
        name: "State 0, 0 neighbors: next state 0",
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(rule).getByRole("button", {
        name: `State 0, 1 neighbors: next state ${initial.seedGenome[1]}`,
      }),
    );
    fireEvent.click(within(rule).getByRole("button", { name: "Apply" }));
    expect(onCreate).not.toHaveBeenCalled();
    await submit();
    const expectedGenome = [...initial.seedGenome];
    expectedGenome[1] = (expectedGenome[1] + 1) % 5;
    expect(onCreate.mock.calls[0][0].seedGenome).toEqual(expectedGenome);
    expect(initial.seedGenome).not.toEqual(expectedGenome);
  });
  it("leaves a rejected server create visible and locks dismissal/submission while busy", async () => {
    const { onCreate, onClose, rerender } = dialog();
    onCreate.mockRejectedValue(new Error("All CPU workers are allocated."));
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "All CPU workers are allocated.",
    );
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <RunDialog
        initial={smallConfig()}
        maxWorkers={6}
        busy
        onCreate={onCreate}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Create paused" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close run configuration" }),
    ).toBeDisabled();
    const event = new Event("cancel", { cancelable: true });
    screen.getByRole("dialog", { name: "New run" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});

async function mountApp(
  detail = fixture.detail,
  withPreview = true,
  autoplay = false,
) {
  const view = render(<App />);
  const socket = ResearchSocket.instances.at(-1)!;
  await http.reply("/api/runs", runList([detail]));
  await http.reply(`/api/runs/${detail.summary.id}`, detail);
  if (!autoplay) {
    fireEvent.click(screen.getByLabelText("Pause CA playback"));
    field("Inspected candidate", "best");
  }
  socket.hello();
  if (withPreview) await finishPreviews(detail);
  return { ...view, socket };
}
async function finishPreviews(detail = fixture.detail) {
  // A genotype change can cancel an earlier preview; fulfill only the active
  // requests here. Stale previews are exercised explicitly in a separate test.
  for (const entry of http.requests.filter(
    (r) => !r.settled && r.path.endsWith("/preview"),
  )) {
    const body = JSON.parse(String(entry.options.body));
    await act(async () =>
      entry.resolve(previewFor(detail, body.genome, body.seed)),
    );
  }
}
function volumeProps(): VolumeProps {
  return viewport.render.mock.calls.at(-1)![0];
}
function uploadFile(text: string, bytes?: number) {
  const file = new File([text], "checkpoint.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", {
    value: vi.fn().mockResolvedValue(text),
  });
  if (bytes !== undefined)
    Object.defineProperty(file, "size", { value: bytes });
  return file;
}
async function uploadCheckpoint(file: File) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Import research checkpoint"), {
      target: { files: [file] },
    });
  });
}

describe("API-backed research workbench", () => {
  it("loops through training and held-out soups with a fixed rule and stable fixture controls", async () => {
    const soup = await researchFixture("soup-run", 0, {
      seed: "soup",
      soupSize: 6,
      steps: 8,
      trainingSeeds: [1, 2],
      validationSeeds: [3],
    });
    vi.useFakeTimers();
    await mountApp(soup.detail, true, true);
    const selector = screen.getByLabelText("Preview fixture");
    const status = screen.getByLabelText("Fixture boundary contacts");
    expect(screen.getByLabelText("Loop animation")).toBeChecked();
    expect(screen.getByLabelText("Starting configuration")).toHaveTextContent(
      "Soup 6 × 6",
    );
    const genome = soup.detail.snapshot!.champion.genome;
    expect(screen.getByLabelText("Pause CA playback")).toBeEnabled();
    for (const seed of [2, 3, 1]) {
      const end = Number(
        screen.getByLabelText("CA timestep").getAttribute("max"),
      );
      for (let step = 1; step < end; step++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25);
        });
      const previous = (selector as HTMLSelectElement).value;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(199);
      });
      expect(selector).toHaveValue(previous);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(selector).toHaveValue(String(seed));
      expect(screen.getByLabelText("Preview fixture")).toBe(selector);
      expect(screen.getByLabelText("Fixture boundary contacts")).toBe(status);
      expect(status).toHaveTextContent("Loading fixture");
      const pending = http.pending("/api/runs/soup-run/preview", "POST");
      expect(JSON.parse(String(pending.options.body))).toMatchObject({
        genome,
        seed,
      });
      await finishPreviews(soup.detail);
      expect(volumeProps().visibleLayers).toBe(1);
      expect(screen.getByLabelText("Pause CA playback")).toBeEnabled();
    }
    fireEvent.click(screen.getByLabelText("Loop animation"));
    const end = Number(
      screen.getByLabelText("CA timestep").getAttribute("max"),
    );
    for (let step = 1; step < end; step++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });
    expect(screen.getByLabelText("Play CA history")).toBeEnabled();
    expect(volumeProps().visibleLayers).toBe(end);
  });
  it("defaults to 4× playback and changes speed immediately", async () => {
    vi.useFakeTimers();
    await mountApp(fixture.detail, true, true);
    expect(screen.getByLabelText("Animation speed")).toHaveValue("4");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(volumeProps().visibleLayers).toBe(2);
    field("Animation speed", "1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(volumeProps().visibleLayers).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(volumeProps().visibleLayers).toBe(3);
    field("CA timestep", 4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(volumeProps().visibleLayers).toBe(4);
  });
  it("waits for the longest visible model and holds exactly 200ms without empty cutoff padding", async () => {
    vi.useFakeTimers();
    const short = Array(45).fill(0);
    short[9] = 2;
    const long = short.slice();
    long[18] = 3;
    long[27] = 4;
    const example = await researchFixture("finite", 0, {
      seed: "point",
      steps: 32,
      seedGenome: short,
      trainingSeeds: [1729],
      validationSeeds: [],
    });
    const snapshot = example.detail.snapshot!;
    snapshot.population = [
      { ...snapshot.population[0], id: "short", genome: short, fitness: 0.1 },
      { ...snapshot.population[1], id: "long", genome: long, fitness: 0.2 },
    ];
    await mountApp(example.detail, true, true);
    field("Inspected candidate", "generation");
    await act(async () => {
      volumeProps().gallery!.onSelect(0);
    });
    await finishPreviews(example.detail);
    act(() => volumeProps().gallery!.onVisibleChange!([0, 1]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(volumeProps().visibleLayers).toBe(1); // Wait for the visible neighbor.
    await finishPreviews(example.detail);
    expect(screen.getByLabelText("CA timestep")).toHaveAttribute("max", "4");
    for (let layer = 2; layer <= 4; layer++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });
      expect(volumeProps().visibleLayers).toBe(layer);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(volumeProps().visibleLayers).toBe(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(volumeProps().visibleLayers).toBe(1);
    expect(volumeProps().simulation.layers).toHaveLength(32);
  });
  it("honors pause during fixture loading and leaves fixture status mounted when browsing", async () => {
    const soup = await researchFixture("soup-run", 0, {
      seed: "soup",
      soupSize: 6,
      steps: 8,
      trainingSeeds: [1, 2],
      validationSeeds: [],
    });
    vi.useFakeTimers();
    await mountApp(soup.detail, true, true);
    const end = Number(
      screen.getByLabelText("CA timestep").getAttribute("max"),
    );
    for (let step = 1; step < end; step++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(screen.getByLabelText("Pause CA playback"));
    await finishPreviews(soup.detail);
    expect(screen.getByLabelText("Play CA history")).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByLabelText("Preview fixture")).toHaveValue("2");
    const status = screen.getByLabelText("Fixture boundary contacts");
    field("Inspected candidate", "generation");
    fireEvent.click(screen.getByLabelText("Previous model"));
    expect(screen.getByLabelText("Fixture boundary contacts")).toBe(status);
    expect(status).toHaveTextContent("Loading fixture");
    await finishPreviews(soup.detail);
    expect(screen.getByLabelText("Fixture boundary contacts")).toBe(status);
  });
  it("starts empty without fabricating a population or creating a browser-owned job", async () => {
    render(<App />);
    expect(screen.getByText("Loading runs…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    await http.reply("/api/runs", runList());
    ResearchSocket.instances[0].hello();
    expect(screen.getByText("Select or create an experiment.")).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "Run registry" }),
    ).toBeVisible();
    expect(viewport.render).not.toHaveBeenCalled();
    expect(http.mutations).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "New run" })[0]);
    expect(screen.getByRole("dialog", { name: "New run" })).toBeVisible();
  });
  it("renders an actual registry, measured population and auto-fit VM preview, with hideable analysis", async () => {
    const { socket } = await mountApp();
    expect(
      screen.getByRole("button", {
        name: `Select run ${fixture.detail.config.name}`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Population",
      "Genetics",
      "History",
      "Compare",
      "Parameters",
    ]);
    const rows = within(
      screen.getByRole("table", {
        name: "Population ranked by training fitness",
      }),
    ).getAllByRole("row");
    expect(rows).toHaveLength(fixture.state.population.length + 1);
    expect(
      screen.getByRole("region", { name: "Run metrics" }),
    ).toHaveTextContent(String(fixture.state.evaluations));
    expect(volumeProps()).toMatchObject({
      fitMode: "specimen",
      visibleLayers: fixture.detail.config.steps,
      simulation: { size: fixture.detail.config.size },
    });
    expect(volumeProps().simulation.layers[0]).toEqual(
      Uint8Array.from(atob(fixture.preview.simulation.layers[0]), (c) =>
        c.charCodeAt(0),
      ),
    );
    const posts = http.mutations.length;
    fireEvent.click(screen.getByRole("button", { name: "Focus champion" }));
    expect(
      screen.queryByRole("complementary", { name: "Run registry" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Run metrics" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("tablist")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Hide analysis panels" }),
    );
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show analysis panels" }),
    );
    expect(screen.getByRole("tabpanel", { name: "Population" })).toBeVisible();
    expect(http.mutations).toHaveLength(posts);
    expect(
      socket.messages.every((message) => message.type === "subscribe"),
    ).toBe(true);
  });
  it.each(["paused", "running"] as const)(
    "Space selects a population row without changing a %s training run",
    async (status) => {
      const detail = changed(fixture.detail, { status });
      await mountApp(detail);
      const candidate = fixture.state.population.find(
        (value) => value.id !== fixture.state.champion.id,
      )!;
      fireEvent.keyDown(
        screen.getByRole("row", {
          name: new RegExp(`individual ${candidate.id},`),
        }),
        { key: " ", code: "Space", bubbles: true, cancelable: true },
      );
      expect(
        screen.getByRole("combobox", { name: "Inspected candidate" }),
      ).toHaveValue("selected");
      expect(
        http.mutations.filter((entry) => entry.path.endsWith("/actions")),
      ).toHaveLength(0);
      await finishPreviews(detail);
    },
  );

  it("selects real offspring, requests their exact genotype, and shows recorded rather than invented ancestry", async () => {
    await mountApp();
    const offspring = fixture.state.population.find(
      (value) =>
        value.parents.length &&
        value.mutatedLoci.length &&
        value.id !== fixture.state.champion.id,
    )!;
    expect(offspring).toBeDefined();
    fireEvent.click(
      screen.getByRole("row", {
        name: new RegExp(`individual ${offspring.id},`),
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Inspected candidate" }),
    ).toHaveValue("selected");
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-a/preview", "POST").options.body),
      ),
    ).toEqual({
      genome: offspring.genome,
      seed: fixture.detail.config.trainingSeeds[0],
    });
    await finishPreviews();
    fireEvent.click(screen.getByRole("tab", { name: "Genetics" }));
    const genetics = screen.getByRole("region", {
      name: "Genetics and immediate ancestry",
    });
    expect(genetics).toHaveTextContent(offspring.id);
    for (const parent of offspring.parents)
      expect(genetics).toHaveTextContent(parent.id);
    expect(genetics).toHaveTextContent(
      `Mutated loci ${offspring.mutatedLoci.length}`,
    );
    expect(
      within(genetics).getByRole("table", {
        name: "Selected rule: current state by active Moore neighbors",
      }),
    ).toBeVisible();
    field("Inspected candidate", "best");
    await finishPreviews();
    expect(genetics).toHaveTextContent(fixture.state.champion.id);
  });
  it("browses a generation in order without changing its source, coordinates genetics, and rejects stale specimen frames", async () => {
    await mountApp();
    field("Inspected candidate", "generation");
    await finishPreviews();
    const gallery = volumeProps().gallery!;
    expect(gallery.index).toBe(gallery.items.length - 1);
    expect(gallery.items).toHaveLength(fixture.state.population.length);
    expect(screen.getByLabelText("Gallery position")).toHaveTextContent(
      "8 / 8",
    );
    const target = gallery.items.findIndex((item) => {
      const individual = fixture.state.population.find(
        (value) => value.id === item.id,
      )!;
      return (
        individual.genome.join(",") !== fixture.state.champion.genome.join(",")
      );
    });
    act(() => gallery.onSelect(target));
    expect(screen.getByLabelText("Inspected candidate")).toHaveValue(
      "generation",
    );
    expect(volumeProps().gallery!.items[target].simulation).toBeUndefined();
    await finishPreviews();
    fireEvent.click(screen.getByRole("tab", { name: "Genetics" }));
    expect(
      screen.getByRole("region", { name: "Genetics and immediate ancestry" }),
    ).toHaveTextContent(gallery.items[target].id);
    expect(volumeProps().gallery!.items[target].simulation).toBeDefined();
    const inspector = screen.getByRole("region", {
      name: "Champion inspector",
    });
    fireEvent.keyDown(inspector, { key: "End" });
    expect(screen.getByLabelText("Gallery position")).toHaveTextContent(
      "8 / 8",
    );
    fireEvent.keyDown(inspector, { key: "ArrowLeft" });
    expect(screen.getByLabelText("Gallery position")).toHaveTextContent(
      "7 / 8",
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "CA timestep" }), {
      key: "Home",
    });
    expect(screen.getByLabelText("Gallery position")).toHaveTextContent(
      "7 / 8",
    );
    expect(
      http.mutations.filter((entry) => entry.path.endsWith("/actions")),
    ).toHaveLength(0);
    field("Inspected candidate", "best");
    await finishPreviews();
    expect(volumeProps().gallery!.items.at(-1)!.id).toBe(
      fixture.state.champion.id,
    );
    expect(volumeProps().gallery!.index).toBe(
      volumeProps().gallery!.items.length - 1,
    );
  });

  it("loads retained populations separately from live generation metrics and returns to latest", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(
      screen.getByRole("img", { name: /Fitness by GA generation/ }),
    ).toBeVisible();
    field("Retained generation", "0");
    expect(screen.getByText("Loading population…")).toBeVisible();
    await http.reply("/api/runs/run-a/generations/0", fixture.snapshots[0]);
    await finishPreviews();
    expect(
      screen.getByRole("combobox", { name: "Inspected candidate" }),
    ).toHaveValue("generation");
    fireEvent.click(screen.getByRole("tab", { name: "Population" }));
    expect(
      screen.getByText("Generation 0 · 8 individuals · fitness descending"),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Run metrics" }),
    ).toHaveTextContent("Generation2 / ∞");
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    await finishPreviews();
    fireEvent.click(screen.getByRole("tab", { name: "Population" }));
    expect(
      screen.getByText("Generation 2 · 8 individuals · fitness descending"),
    ).toBeVisible();
  });
  it("starts and stops the right-clicked run without switching the selected run", async () => {
    const other = changed(fixture.detail, {
      id: "run-b",
      name: "Other run",
      status: "running",
    });
    const { socket } = await mountApp();
    act(() =>
      socket.reply({ type: "runs", ...runList([fixture.detail, other]) }),
    );
    const row = screen.getByLabelText("Select run Other run");
    fireEvent.contextMenu(row, { clientX: 140, clientY: 210 });
    const menu = screen.getByRole("menu", { name: "Run actions" });
    expect(
      within(menu).getByRole("menuitem", { name: "Start" }),
    ).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-b/actions", "POST").options.body),
      ),
    ).toEqual({ action: "pause" });
    expect(
      screen.getByLabelText(`Select run ${fixture.detail.config.name}`),
    ).toHaveAttribute("aria-pressed", "true");
    await http.reply(
      "/api/runs/run-b/actions",
      changed(other, { status: "paused" }),
      "POST",
    );
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Start" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Start" }));
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-b/actions", "POST").options.body),
      ),
    ).toEqual({ action: "start" });
    await http.reply("/api/runs/run-b/actions", other, "POST");
    fireEvent.contextMenu(row);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
  it("sends Step/Start/Pause over HTTP, disables concurrent controls, and preserves accepted state on failure", async () => {
    await mountApp();
    fireEvent.click(
      screen.getByRole("button", { name: "Step one generation" }),
    );
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-a/actions", "POST").options.body),
      ),
    ).toEqual({ action: "step" });
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save checkpoint" }),
    ).toBeDisabled();
    await http.reply("/api/runs/run-a/actions", fixture.detail, "POST");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    const running = changed(fixture.detail, {
      status: "running",
      workerCount: 1,
      updatedAt: "2026-01-01T00:00:10.000Z",
    });
    await http.reply("/api/runs/run-a/actions", running, "POST");
    expect(screen.getByRole("button", { name: "Pause run" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Step one generation" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pause run" }));
    await http.reply(
      "/api/runs/run-a/actions",
      { error: "Unable to save checkpoint." },
      "POST",
      500,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to save checkpoint.",
    );
    expect(screen.getByRole("button", { name: "Pause run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("treats time, closeup, materials and camera as local views, not job mutations", async () => {
    await mountApp();
    const requests = http.requests.length;
    const fullDepth = volumeProps().visibleLayers;
    fireEvent.click(
      screen.getByRole("button", { name: "Click rendered model" }),
    );
    expect(volumeProps().onLayerSelect).toBeUndefined();
    expect(volumeProps().visibleLayers).toBe(fullDepth);
    field("CA timestep", 4);
    expect(screen.getByRole("slider", { name: "CA timestep" })).toHaveValue(
      "4",
    );
    expect(volumeProps().visibleLayers).toBe(4);
    fireEvent.click(
      screen.getByRole("button", { name: "Inspector view options" }),
    );
    const compression = screen.getByRole("checkbox", { name: "Compress time" });
    expect(compression).not.toBeChecked();
    expect(volumeProps().compressTime).toBe(false);
    expect(screen.getByLabelText("Time scale")).toHaveTextContent("Time 1:1");
    fireEvent.click(compression);
    expect(volumeProps().compressTime).toBe(true);
    expect(screen.getByLabelText("Time scale")).toHaveTextContent(
      "Time compressed",
    );
    fireEvent.click(compression);
    expect(volumeProps().compressTime).toBe(false);
    field("Preview display", "slice");
    expect(compression).toBeDisabled();
    expect(volumeProps()).toMatchObject({ view: "top", visibleLayers: 1 });
    expect(volumeProps().simulation.layers).toHaveLength(1);
    field("Render material", "points");
    field("Palette", "ember");
    expect(volumeProps()).toMatchObject({ mode: "points", palette: "ember" });
    const resetKey = volumeProps().resetKey;
    fireEvent.click(
      screen.getByRole("button", { name: "Reset specimen camera" }),
    );
    expect(volumeProps().resetKey).toBeGreaterThan(resetKey!);
    expect(http.requests).toHaveLength(requests);
  });
  it("rejects a stale preview after switching runs and requests the selected run's own fixture", async () => {
    const other = await researchFixture("run-b", 0, {
      name: "Other world",
      size: 11,
      seed: "islands",
      trainingSeeds: [23],
    });
    const { socket } = await mountApp(fixture.detail, false);
    const old = http.pending("/api/runs/run-a/preview", "POST");
    socket.reply({ type: "runs", ...runList([fixture.detail, other.detail]) });
    fireEvent.click(
      screen.getByRole("button", { name: "Select run Other world" }),
    );
    expect((old.options.signal as AbortSignal).aborted).toBe(true);
    await http.reply("/api/runs/run-b", other.detail);
    await http.reply("/api/runs/run-b/preview", other.preview, "POST");
    await act(async () => old.resolve(fixture.preview));
    expect(volumeProps().simulation.size).toBe(11);
    expect(
      screen.getByRole("combobox", { name: "Preview fixture" }),
    ).toHaveValue("23");
  });
  it("requests consecutive interior windows and restores the whole horizon without job actions", async () => {
    await mountApp();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspector view options" }),
    );
    field("Preview start timestep", 3);
    field("Preview end timestep", 5);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-a/preview", "POST").options.body),
      ),
    ).toMatchObject({ range: { start: 3, end: 5 } });
    const partial = {
      ...fixture.preview,
      layerTimes: [3, 4, 5],
      simulation: {
        ...fixture.preview.simulation,
        layers: fixture.preview.simulation.layers.slice(3, 6),
      },
    };
    await http.reply("/api/runs/run-a/preview", partial, "POST");
    expect(volumeProps().simulation.layerTimes).toEqual([3, 4, 5]);
    expect(screen.getByLabelText("Time scale")).toHaveTextContent(
      "Every step · t 3–5",
    );
    fireEvent.click(screen.getByRole("button", { name: "Full horizon" }));
    expect(
      JSON.parse(
        String(http.pending("/api/runs/run-a/preview", "POST").options.body),
      ),
    ).not.toHaveProperty("range");
    await http.reply("/api/runs/run-a/preview", fixture.preview, "POST");
    expect(volumeProps().simulation.layers).toHaveLength(
      fixture.preview.totalSteps,
    );
    expect(
      http.requests.filter((request) => request.path.endsWith("/actions")),
    ).toHaveLength(0);
  });
  it("explains worker admission while a run is waiting to initialize", async () => {
    const waiting = changed(fixture.detail, {
      status: "queued",
      generation: -1,
      queuePosition: 1,
      workerCount: 0,
    });
    await mountApp(waiting);
    expect(
      screen.getByRole("button", { name: `Select run ${waiting.config.name}` }),
    ).toHaveTextContent("Waiting for capacity");
    expect(screen.getByText(/Queued #1: waiting for/)).toHaveTextContent(
      "Runs start in queue order",
    );
    expect(screen.queryByText("Initialization failed")).not.toBeInTheDocument();
  });
  it("does not pause jobs on unmount and keeps native controls available after observer-only disconnect", async () => {
    const running = changed(fixture.detail, {
      status: "running",
      workerCount: 1,
    });
    const { socket, unmount } = await mountApp(running);
    const before = http.mutations.length;
    socket.disconnect();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /VM runs are unaffected/,
    );
    expect(screen.getByRole("button", { name: "Pause run" })).toBeEnabled();
    unmount();
    expect(http.mutations).toHaveLength(before);
  });
  it.each([false, true])(
    "opens Fork as an editable copy of parameters, including before initialization (%s)",
    async (uninitialized) => {
      const original = (
        await researchFixture("fork-source", 2, {
          initialization: "random",
          seed: "soup",
          soupSize: 6,
          trainingSeeds: [11, 12],
          validationSeeds: [21],
          incentives: [
            presetIncentive("lightExposure"),
            { ...presetIncentive("avoidRepeatedReuse"), weight: 3 },
          ],
        })
      ).detail;
      const source = uninitialized
        ? {
            ...changed(original, { generation: -1 }),
            snapshot: null,
            improvements: [],
            history: [],
          }
        : original;
      const saved = structuredClone(source);
      await mountApp(source);
      const posts = http.mutations.length;
      const fork = screen.getByRole("button", { name: "Fork run" });
      expect(fork).toBeEnabled();
      fireEvent.click(fork);
      const creator = screen.getByRole("dialog", { name: "Fork run" });
      fireEvent.click(
        within(creator).getByLabelText("Edit configuration JSON"),
      );
      const copied = JSON.parse(
        (
          within(creator).getByLabelText(
            "Configuration JSON",
          ) as HTMLTextAreaElement
        ).value,
      );
      expect(copied).toEqual({
        ...source.config,
        name: `${source.config.name} (fork)`,
      });
      expect(copied.seedGenome).toEqual(source.config.seedGenome);
      expect(copied.initialization).toBe("random");
      expect(http.mutations).toHaveLength(posts);
      fireEvent.click(
        within(creator).getByLabelText("Close run configuration"),
      );
      expect(http.mutations).toHaveLength(posts);
      fireEvent.click(fork);
      field("Mutation probability", 0.2);
      field("Incentive 2 weight", 5);
      fireEvent.click(screen.getByRole("button", { name: "Create paused" }));
      const request = http.pending("/api/runs", "POST");
      const payload = JSON.parse(String(request.options.body));
      expect(payload).toEqual({
        config: {
          ...copied,
          mutationRate: 0.2,
          incentives: [
            copied.incentives[0],
            { ...copied.incentives[1], weight: 5 },
          ],
        },
        start: false,
      });
      expect(http.mutations.some((entry) => entry.path.endsWith("/fork"))).toBe(
        false,
      );
      expect(source).toEqual(saved);
      await http.reply(
        "/api/runs",
        {
          ...source,
          config: payload.config,
          summary: { ...source.summary, id: "fork-created", generation: -1 },
        },
        "POST",
        201,
      );
      expect(
        screen.queryByRole("dialog", { name: "Fork run" }),
      ).not.toBeInTheDocument();
    },
  );
  it("displays immutable configuration and seeds a variant from the champion even after random initialization", async () => {
    const source = (
      await researchFixture("random-source", 2, { initialization: "random" })
    ).detail;
    await mountApp(source);
    fireEvent.click(screen.getByRole("tab", { name: "Parameters" }));
    expect(
      JSON.parse(screen.getByLabelText("Run configuration").textContent!),
    ).toEqual(source.config);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    const posts = http.mutations.length;
    fireEvent.click(
      screen.getByRole("button", { name: "New variant from champion" }),
    );
    const configDialog = screen.getByRole("dialog", {
      name: "New variant from champion",
    });
    expect(within(configDialog).getByLabelText("Run name")).toHaveValue(
      `${source.config.name} · variant`,
    );
    fireEvent.click(
      within(configDialog).getByRole("button", {
        name: "Edit configuration JSON",
      }),
    );
    const config = JSON.parse(
      (
        within(configDialog).getByLabelText(
          "Configuration JSON",
        ) as HTMLTextAreaElement
      ).value,
    );
    expect(config).toEqual({
      ...source.config,
      incentives: incentivesForConfig(source.config),
      name: `${source.config.name} · variant`,
      seedGenome: source.snapshot!.champion.genome,
      initialization: "mutants",
    });
    fireEvent.click(
      within(configDialog).getByRole("button", {
        name: "Close run configuration",
      }),
    );
    expect(http.mutations).toHaveLength(posts);
  });
  it.each<Partial<RunConfig>>([
    { objective: "growth" },
    { incentives: [presetIncentive("growth")] },
    { boundaryPolicy: { spatial: false, horizon: true } },
    { boundaryPolicy: { spatial: true, horizon: false } },
  ])(
    "warns when comparison evaluation settings differ: %j",
    async (settings) => {
      const other = await researchFixture("comparison-run", 1, {
        name: "Different evaluation",
        ...settings,
      });
      const { socket } = await mountApp();
      socket.reply({
        type: "runs",
        ...runList([fixture.detail, other.detail]),
      });
      fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
      await http.reply("/api/runs/run-a", fixture.detail);
      field("Add comparison run", "comparison-run");
      await http.reply("/api/runs/run-a", fixture.detail);
      await http.reply("/api/runs/comparison-run", other.detail);
      expect(
        screen.getByText(
          "Different evaluation settings: these fitness scores are not directly comparable.",
        ),
      ).toBeVisible();
      const chart = screen.getByRole("img", {
        name: "Best fitness comparison by selected run",
      });
      expect(chart.querySelectorAll("polyline")).toHaveLength(2);
      const requestCount = http.requests.length;
      field("Comparison axis", "generation");
      expect(http.requests).toHaveLength(requestCount);
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh comparison" }),
      );
      await http.reply(
        "/api/runs/run-a",
        { error: "Run is temporarily unavailable." },
        "GET",
        503,
      );
      await http.reply("/api/runs/comparison-run", other.detail);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Run is temporarily unavailable.",
      );
    },
  );
  it("checkpoints durably before starting a download and imports complete state as a new paused identity", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await mountApp();
    fireEvent.click(screen.getByRole("tab", { name: "Parameters" }));
    fireEvent.click(screen.getByRole("button", { name: "Export checkpoint" }));
    expect(click).not.toHaveBeenCalled();
    await http.reply("/api/runs/run-a/actions", fixture.detail, "POST");
    expect(click).toHaveBeenCalledOnce();
    expect(
      (click.mock.contexts[0] as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/api/runs/run-a/checkpoint");
    await uploadCheckpoint(uploadFile(JSON.stringify(fixture.checkpoint)));
    expect(
      JSON.parse(String(http.pending("/api/runs/import", "POST").options.body)),
    ).toEqual({ checkpoint: fixture.checkpoint, start: false });
    const imported = changed(fixture.detail, {
      id: "imported-run",
      name: "Imported checkpoint",
      parentRunId: "run-a",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    await http.reply("/api/runs/import", imported, "POST");
    expect(
      screen.getByRole("button", { name: "Select run Imported checkpoint" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  });
  it.each(["not json", JSON.stringify({ invalid: true })])(
    "reports invalid imported data without replacing current research: %s",
    async (text) => {
      await mountApp();
      const mutations = http.mutations.length;
      await uploadCheckpoint(uploadFile(text));
      expect(screen.getByRole("alert")).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: `Select run ${fixture.detail.config.name}`,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(http.mutations).toHaveLength(mutations);
    },
  );
  it("rejects oversized imports before reading or sending them", async () => {
    await mountApp();
    const file = uploadFile("{}", 16 * 1024 * 1024 + 1);
    await uploadCheckpoint(file);
    expect(file.text).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Checkpoint exceeds 16 MiB.",
    );
  });
});

describe("editable research state counts", () => {
  it.each([2, 16])(
    "edits and submits every row of a %i-state founder, including output cycling",
    async (stateCount) => {
      const { onCreate } = dialog();
      field("State count", stateCount);
      if (stateCount === 2) field("Founder preset", "life");
      fireEvent.click(
        screen.getByRole("button", { name: `Edit ${stateCount * 9} outputs` }),
      );
      const rule = screen.getByRole("dialog", { name: "Rule" });
      const cells = within(rule).getAllByRole("button", {
        name: /^State \d+, \d+ neighbors:/,
      });
      expect(cells).toHaveLength(stateCount * 9);
      expect(cells[0]).toBeDisabled();
      const cell = cells.at(-1)!;
      const previous = Number(cell.textContent);
      fireEvent.click(cell);
      expect(Number(cell.textContent)).toBe((previous + 1) % stateCount);
      // A full alphabet cycle returns to the same output.
      for (let i = 1; i < stateCount; i++) fireEvent.click(cell);
      expect(Number(cell.textContent)).toBe(previous);
      fireEvent.click(within(rule).getByRole("button", { name: "Apply" }));
      await submit();
      const config = onCreate.mock.calls[0][0] as RunConfig;
      expect(config.stateCount).toBe(stateCount);
      expect(config.seedGenome).toHaveLength(stateCount * 9);
      expect(
        config.seedGenome.every((state) => state >= 0 && state < stateCount),
      ).toBe(true);
    },
  );
});
