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
        Inspect rendered layer three
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
    field("Objective", "complexity");
    field("Aggregation", "minimum");
    field("State entropy weight", 0.1);
    field("Motion weight", 0.2);
    field("Density weight", 0.3);
    field("Variation weight", 0.4);
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
      objective: "complexity",
      aggregation: "minimum",
      weights: { diversity: 0.1, activity: 0.2, density: 0.3, variation: 0.4 },
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
    expect(screen.getByLabelText("Objective", { exact: true })).toHaveValue(
      "growth",
    );
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

async function mountApp(detail = fixture.detail, withPreview = true) {
  const view = render(<App />);
  const socket = ResearchSocket.instances.at(-1)!;
  await http.reply("/api/runs", runList([detail]));
  await http.reply(`/api/runs/${detail.summary.id}`, detail);
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
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect rendered layer three" }),
    );
    expect(screen.getByRole("slider", { name: "CA timestep" })).toHaveValue(
      "4",
    );
    expect(volumeProps().visibleLayers).toBe(4);
    fireEvent.click(
      screen.getByRole("button", { name: "Inspector view options" }),
    );
    field("Preview display", "slice");
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
  it("displays immutable configuration and opens an explicit champion-derived variant instead of mutating a job", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("tab", { name: "Parameters" }));
    expect(
      JSON.parse(screen.getByLabelText("Run configuration").textContent!),
    ).toEqual(fixture.detail.config);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    const posts = http.mutations.length;
    fireEvent.click(
      screen.getByRole("button", { name: "New variant from champion" }),
    );
    const configDialog = screen.getByRole("dialog", {
      name: "New variant from champion",
    });
    expect(within(configDialog).getByLabelText("Run name")).toHaveValue(
      `${fixture.detail.config.name} · variant`,
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
      ...fixture.detail.config,
      name: `${fixture.detail.config.name} · variant`,
      seedGenome: fixture.state.champion.genome,
    });
    fireEvent.click(
      within(configDialog).getByRole("button", {
        name: "Close run configuration",
      }),
    );
    expect(http.mutations).toHaveLength(posts);
  });
  it("compares frozen HTTP histories and warns when fitness objectives are not comparable", async () => {
    const other = await researchFixture("comparison-run", 1, {
      name: "Different objective",
      objective: "growth",
    });
    const { socket } = await mountApp();
    socket.reply({ type: "runs", ...runList([fixture.detail, other.detail]) });
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
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
  });
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
