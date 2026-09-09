import { readFile } from "node:fs/promises";
import {
  incentivesForConfig,
  presetIncentive,
} from "../src/research/incentives";
import { PRESETS } from "../src/simulation";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type {
  ResearchEvent,
  RunCheckpoint,
  RunDetail,
  RunConfig,
} from "../src/research/types";

interface Observation {
  errors: string[];
  sent: { type: string; runId?: string | null }[];
  received: ResearchEvent[];
  browserWorkers: string[];
  mutations: string[];
}
let observations: Map<Page, Observation>;
let createdIds: Set<string>;
function observe(page: Page) {
  if (observations.has(page)) return;
  const value: Observation = {
    errors: [],
    sent: [],
    received: [],
    browserWorkers: [],
    mutations: [],
  };
  observations.set(page, value);
  page.on("pageerror", (error) => value.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") value.errors.push(message.text());
  });
  page.on("worker", (worker) => value.browserWorkers.push(worker.url()));
  page.on("request", (request) => {
    if (request.method() === "POST" && !request.url().endsWith("/preview"))
      value.mutations.push(request.url());
  });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/research/ws")) return;
    socket.on("framesent", (frame) =>
      value.sent.push(JSON.parse(frame.payload.toString())),
    );
    socket.on("framereceived", (frame) =>
      value.received.push(JSON.parse(frame.payload.toString())),
    );
  });
}
async function detail(
  request: APIRequestContext,
  id: string,
): Promise<RunDetail> {
  const response = await request.get(`/api/runs/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function checkpoint(
  request: APIRequestContext,
  id: string,
): Promise<RunCheckpoint> {
  const response = await request.get(`/api/runs/${id}/checkpoint`);
  expect(response.ok()).toBe(true);
  return response.json();
}
/** The creator shows one section at a time: Goal, Starting worlds, Search, Budget. */
async function section(
  dialog: Locator,
  name: "Goal" | "Starting worlds" | "Search" | "Budget",
) {
  const button = dialog.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "true");
}
async function open(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Live VM connection" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New run", exact: true }).first(),
  ).toBeEnabled();
}
test.beforeEach(async ({ page, context, request }) => {
  observations = new Map();
  createdIds = new Set();
  observe(page);
  context.on("page", observe);
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    status: "ok",
    execution: "node:worker_threads",
    modelVersion: "ca-moore-research-v3",
  });
  await open(page);
});
test.afterEach(async ({ request }, testInfo) => {
  // Cleanup is scoped to this test's returned identities, never a registry-wide
  // delete. Archive only disposable fixtures, even with an explicit external URL.
  for (const id of createdIds) {
    const response = await request.post(`/api/runs/${id}/actions`, {
      data: { action: "archive" },
    });
    if (!response.ok())
      await testInfo.attach(`cleanup-${id}`, {
        body: await response.text(),
        contentType: "text/plain",
      });
    expect(response.ok(), `archive disposable run ${id}`).toBe(true);
  }
  for (const value of observations.values()) {
    expect(
      value.errors,
      "No browser exceptions, shader failures, or console errors",
    ).toEqual([]);
    expect(
      value.browserWorkers,
      "Research must execute on the VM, not browser workers",
    ).toEqual([]);
    expect(
      value.sent.every((message) => message.type === "subscribe"),
      "WebSockets observe; HTTP controls jobs",
    ).toBe(true);
  }
});
async function createRun(
  page: Page,
  testInfo: TestInfo,
  start = false,
  overrides: Partial<RunConfig> = {},
  autoplay = false,
) {
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Edit configuration JSON" }).click();
  const editor = dialog.getByRole("textbox", { name: "Configuration JSON" });
  const initial = JSON.parse(await editor.inputValue()) as RunConfig;
  const config: RunConfig = {
    ...initial,
    initialization: "mutants",
    randomRuleBias: "uniform",
    name: `e2e-${Date.now()}-${testInfo.workerIndex}`,
    size: 25,
    steps: 32,
    populationSize: 8,
    eliteCount: 2,
    evaluationWorkers: 1,
    checkpointSeconds: 2,
    snapshotEvery: 1,
    retainedSnapshots: 8,
    cacheSize: 128,
    mutationRate: 0.12,
    ...overrides,
  };
  if (overrides.objective && !overrides.incentives)
    config.incentives = incentivesForConfig({
      ...config,
      incentives: undefined,
    });
  // Beta belongs to heavy-tailed mutation only.
  if (config.mutationPolicy === "independent") delete config.mutationBeta;
  await editor.fill(JSON.stringify(config, null, 2));
  // Switching back verifies JSON is accepted by the same editable fields users use.
  await dialog.getByRole("button", { name: "Use parameter fields" }).click();
  await section(dialog, "Starting worlds");
  await expect(
    dialog.getByRole("spinbutton", { name: "Grid size", exact: true }),
  ).toHaveValue(String(config.size));
  await section(dialog, "Budget");
  await expect(
    dialog.getByRole("spinbutton", { name: "Generation limit", exact: true }),
  ).toHaveValue(String(config.maxGenerations));
  await expect(
    dialog.getByRole("complementary", { name: "Experiment summary" }),
  ).toContainText(`${config.populationSize} rules`);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", {
      name: start ? "Create & start" : "Create paused",
      exact: true,
    })
    .click();
  const created = await response;
  expect(created.status()).toBe(201);
  const run = (await created.json()) as RunDetail;
  createdIds.add(run.summary.id);
  expect(run.config).toEqual(config);
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: `Select run ${config.name}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  if (
    (page.viewportSize()?.width ?? 1440) < 700 &&
    (await page
      .getByRole("button", { name: "Toggle run registry" })
      .getAttribute("aria-pressed")) === "true"
  )
    await page.getByRole("button", { name: "Toggle run registry" }).click();
  if (!autoplay && (await page.getByLabel("Pause CA playback").isVisible()))
    await page.getByLabel("Pause CA playback").click();
  return run;
}
async function waitForPaused(
  page: Page,
  request: APIRequestContext,
  id: string,
) {
  await expect
    .poll(async () => (await detail(request, id)).summary.status)
    .toBe("paused");
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Step one generation" }),
  ).toBeEnabled();
}
async function step(page: Page, request: APIRequestContext, id: string) {
  const before = (await detail(request, id)).summary.generation;
  await page.getByRole("button", { name: "Step one generation" }).click();
  await expect
    .poll(async () => (await detail(request, id)).summary.generation)
    .toBe(before + 1);
  await waitForPaused(page, request, id);
  return detail(request, id);
}
async function exportThroughUI(page: Page, testInfo: TestInfo) {
  await page.getByRole("tab", { name: "Parameters", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export checkpoint", exact: true })
    .click();
  const download = await downloading;
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return {
    path,
    checkpoint: JSON.parse(await readFile(path, "utf8")) as RunCheckpoint,
  };
}
async function screenArtifact(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("new runs default to random contenders while founder mode stays opt-in", async ({
  page,
  request,
}, testInfo) => {
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  await expect(
    dialog.getByRole("complementary", { name: "Experiment summary" }),
  ).toContainText(
    "64 rules · 1 deterministic world, seeds ignored · mean score · heavy-tailed mutation, about 3.7 changes per child (46% single) · 2 distinct elites · tournament of 2 · 3 immigrants per generation · no stall pause · unlimited GA generations",
  );
  await section(dialog, "Search");
  await expect(
    dialog.getByLabel("Initialization", { exact: true }),
  ).toHaveValue("random");
  await expect(
    dialog.getByLabel("Random rule sampling", { exact: true }),
  ).toHaveValue("sparse");
  await dialog
    .getByLabel("Random rule sampling", { exact: true })
    .selectOption("uniform");
  await expect(
    dialog.getByText(/give every output state equal probability/),
  ).toBeVisible();
  await dialog
    .getByLabel("Random rule sampling", { exact: true })
    .selectOption("sparse");
  // Random mode has no founder: the editor appears only for founder mode.
  await expect(dialog.getByLabel("Founder preset", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Edit founder genome" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(
      /Every contender starts with an independently randomized rule/,
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Mutation beta", { exact: true })).toHaveValue(
    "1.5",
  );
  await expect(
    dialog.getByLabel("Mutation changes per child", { exact: true }),
  ).toContainText("P(1)45.6%");
  // Keep initialization untouched; reduce only the workload for this disposable run.
  await dialog
    .getByLabel("Run name", { exact: true })
    .fill(`e2e-random-default-${Date.now()}`);
  await dialog.getByLabel("Population", { exact: true }).fill("8");
  await section(dialog, "Starting worlds");
  await dialog.getByLabel("Grid size", { exact: true }).fill("9");
  await dialog.getByLabel("CA horizon", { exact: true }).fill("8");
  await expect(
    dialog.getByLabel("Effective worlds", { exact: true }),
  ).toContainText("1 deterministic world, seeds ignored");
  await screenArtifact(page, testInfo, "random-default-dialog");
  const creating = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create paused", exact: true })
    .click();
  const response = await creating;
  expect(response.status()).toBe(201);
  const run = (await response.json()) as RunDetail;
  createdIds.add(run.summary.id);
  expect(run.config.initialization).toBe("random");
  expect(run.config.randomRuleBias).toBe("sparse");
  expect(run.config).toMatchObject({
    elitism: "distinct",
    eliteCount: 2,
    tournamentSize: 2,
    mutationPolicy: "heavyTailed",
    mutationBeta: 1.5,
    stallGenerations: 0,
  });
  expect(run.config.randomSeed).not.toBe(1729);
  await expect(
    page.getByText("Example rule · population not initialized", {
      exact: true,
    }),
  ).toBeVisible();
  await step(page, request, run.summary.id);
  const saved = await checkpoint(request, run.summary.id);
  expect(saved.state!.population).toHaveLength(8);
  for (const contender of saved.state!.population) {
    expect(contender.origin).toBe("random");
    expect(contender.parents).toEqual([]);
    expect(contender.genome).not.toEqual(run.config.seedGenome);
  }
});

test("shared pane edges resize the original layout without changing research", async ({
  page,
  request,
}, testInfo) => {
  const run = await createRun(page, testInfo);
  await step(page, request, run.summary.id);
  const registry = page.getByRole("complementary", { name: "Run registry" });
  const inspector = page.getByRole("region", { name: "Champion inspector" });
  const analysis = page.getByRole("region", { name: "Genetic analysis" });
  const metrics = page.getByRole("region", { name: "Run metrics" });
  await expect(page.locator("[data-window], .desktop-bar")).toHaveCount(0);
  const originalRegistry = (await registry.boundingBox())!;
  const originalInspector = (await inspector.boundingBox())!;
  const originalAnalysis = (await analysis.boundingBox())!;
  const originalMetrics = (await metrics.boundingBox())!;
  const mutations = observations.get(page)!.mutations.length;
  async function dragEdge(name: string, dx: number, dy: number) {
    const edge = page.getByRole("separator", { name, exact: true });
    const box = (await edge.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 5 },
    );
    await page.mouse.up();
  }
  await dragEdge("Resize run registry", 90, 0);
  await expect
    .poll(async () => (await registry.boundingBox())!.width)
    .toBeCloseTo(originalRegistry.width + 90, 0);
  expect((await registry.boundingBox())!.x).toBe(originalRegistry.x);
  expect((await inspector.boundingBox())!.x).toBeCloseTo(
    originalInspector.x + 90,
    0,
  );
  await dragEdge("Resize analysis and inspector", 0, -70);
  await expect
    .poll(async () => (await analysis.boundingBox())!.height)
    .toBeCloseTo(originalAnalysis.height + 70, 0);
  expect(
    (await analysis.boundingBox())!.y + (await analysis.boundingBox())!.height,
  ).toBeCloseTo(originalAnalysis.y + originalAnalysis.height, 0);
  await dragEdge("Resize run metrics", 0, 24);
  await expect
    .poll(async () => (await metrics.boundingBox())!.height)
    .toBeCloseTo(originalMetrics.height + 24, 0);
  const edge = page.getByRole("separator", {
    name: "Resize run registry",
    exact: true,
  });
  await edge.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Space");
  await expect
    .poll(async () => (await registry.boundingBox())!.width)
    .toBeCloseTo(originalRegistry.width + 89, 0);
  expect(observations.get(page)!.mutations).toHaveLength(mutations);
  expect((await detail(request, run.summary.id)).summary.generation).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("polyp.pane-sizes.v1") || "{}")
            .registry,
      ),
    )
    .toBeCloseTo(originalRegistry.width + 89, 0);
  await page.reload();
  await expect
    .poll(async () => (await registry.boundingBox())!.width)
    .toBeCloseTo(originalRegistry.width + 89, 0);
  await expect
    .poll(async () => (await analysis.boundingBox())!.height)
    .toBeCloseTo(originalAnalysis.height + 70, 0);
  await page
    .getByRole("separator", { name: "Resize analysis and inspector" })
    .dblclick();
  await expect
    .poll(async () => (await analysis.boundingBox())!.height)
    .toBeCloseTo(originalAnalysis.height, 0);
  await edge.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await registry.boundingBox())!.width)
    .toBeCloseTo(originalRegistry.width, 0);
  await screenArtifact(page, testInfo, "colorful-docked-workbench");
  await page.setViewportSize({ width: 1080, height: 675 });
  await dragEdge("Resize analysis and inspector", 0, -900);
  expect((await inspector.boundingBox())!.height).toBeGreaterThanOrEqual(229);
  expect(
    (await analysis.boundingBox())!.y + (await analysis.boundingBox())!.height,
  ).toBeLessThanOrEqual(676);
  await page.getByRole("button", { name: "Focus champion" }).click();
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("separator")).toHaveCount(3);
});

test("boundary settings disqualify spatial contact in the real evaluator and show the reason", async ({
  page,
  request,
}, testInfo) => {
  await open(page);
  const genome = [0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const run = await createRun(page, testInfo, false, {
    stateCount: 2,
    seedGenome: genome,
    size: 9,
    steps: 16,
    seed: "islands",
    trainingSeeds: [1],
    validationSeeds: [],
    mutationPolicy: "independent",
    mutationRate: 0,
    immigrantRate: 0,
  });
  expect(run.config.boundaryPolicy).toEqual({ spatial: true, horizon: true });
  const evaluated = await step(page, request, run.summary.id);
  expect(
    evaluated.snapshot!.population.every(
      (item) => item.disqualified && item.fitness === 0,
    ),
  ).toBe(true);
  const reason = page.getByLabel("Fixture boundary contacts");
  await expect(reason).toContainText("Disqualified ·");
  await expect(reason).toContainText("left at t=3");
  await expect(reason).toContainText("right at t=12");
  await expect(reason).toContainText("front at t=8");
  await page.getByRole("tab", { name: "Population", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Population ranked by training fitness" }),
  ).toContainText("0.0000 · F");
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  const spatial = dialog.getByLabel("Disqualify spatial edge contact");
  const horizon = dialog.getByLabel("Disqualify time cutoff contact");
  await expect(spatial).toBeChecked();
  await expect(horizon).toBeChecked();
  await spatial.uncheck();
  await horizon.uncheck();
  const examples = dialog.getByRole("table", { name: "Score examples" });
  await expect(examples.getByRole("row")).toHaveCount(6);
  await expect(examples).not.toContainText("Disqualified");
  await dialog.getByRole("button", { name: "Edit configuration JSON" }).click();
  const editor = dialog.getByRole("textbox", { name: "Configuration JSON" });
  expect(JSON.parse(await editor.inputValue()).boundaryPolicy).toEqual({
    spatial: false,
    horizon: false,
  });
  const config = {
    ...run.config,
    name: `e2e-allowed-${Date.now()}`,
    boundaryPolicy: { spatial: false, horizon: false },
  };
  await editor.fill(JSON.stringify(config));
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create paused", exact: true })
    .click();
  const created = await response;
  expect(created.status()).toBe(201);
  const allowed = (await created.json()) as RunDetail;
  createdIds.add(allowed.summary.id);
  expect(allowed.config.boundaryPolicy).toEqual({
    spatial: false,
    horizon: false,
  });
  const qualified = await step(page, request, allowed.summary.id);
  expect(qualified.snapshot!.champion.fitness).toBe(14 / 15);
  expect(qualified.snapshot!.champion.disqualified).toBe(false);
  await expect(reason).toContainText("left at t=3");
  await expect(reason).not.toContainText("disqualified");
  await screenArtifact(page, testInfo, "boundary-settings");
});

test("the default finite-longevity run uses deep scale and previews its full 2,048-timestep horizon", async ({
  page,
}, testInfo) => {
  // Complete dense previews exceed Chromium's default per-response inspector cache.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable", {
    maxResourceBufferSize: 128 * 1024 * 1024,
    maxTotalBufferSize: 192 * 1024 * 1024,
  });
  let previewRequestId = "";
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (response.url.endsWith("/preview")) previewRequestId = requestId;
  });
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  await expect(
    dialog.getByRole("list", { name: "Scoring incentives" }),
  ).toContainText("Finite longevity");
  await expect(dialog).toContainText(
    "Still alive scores zero for this incentive",
  );
  // The worked examples show the horizon rule concretely: survivors score zero.
  const examples = dialog.getByRole("table", { name: "Score examples" });
  await expect(
    examples.getByRole("row", { name: /Cutoff survivor/ }),
  ).toContainText("Disqualified · alive at cutoff");
  await section(dialog, "Starting worlds");
  await expect(
    dialog.getByRole("spinbutton", { name: "Grid size", exact: true }),
  ).toHaveValue("129");
  await expect(
    dialog.getByRole("spinbutton", { name: "CA horizon", exact: true }),
  ).toHaveValue("2048");
  await expect(
    dialog.getByRole("combobox", { name: "Simulation scale" }),
  ).toHaveValue("deep");
  await section(dialog, "Search");
  await expect(
    dialog.getByLabel("Initialization", { exact: true }),
  ).toHaveValue("random");
  await dialog
    .getByLabel("Initialization", { exact: true })
    .selectOption("mutants");
  await expect(
    dialog.getByRole("button", { name: "Edit founder genome" }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Run name", exact: true })
    .fill(`e2e-default-depth-${Date.now()}`);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );
  const previewed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/preview") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create paused", exact: true })
    .click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const run = (await response.json()) as RunDetail;
  createdIds.add(run.summary.id);
  expect(run.config).toMatchObject({
    size: 129,
    steps: 2048,
    objective: "longevity",
  });
  expect(run.summary).toMatchObject({ status: "paused", generation: -1 });
  const frameResponse = await previewed;
  expect(frameResponse.ok()).toBe(true);
  await frameResponse.finished();
  const frame = JSON.parse(
    (await cdp.send("Network.getResponseBody", { requestId: previewRequestId }))
      .body,
  );
  expect(frame.totalSteps).toBe(2048);
  expect(frame.layerTimes.at(-1)).toBe(2047);
  expect(frame.encoding).toBe("adaptive-v1");
  expect(frame.stride).toBe(1);
  expect(frame.layerTimes).toEqual(Array.from({ length: 2048 }, (_, i) => i));
  await page.getByLabel("Pause CA playback").click();
  await page.getByRole("slider", { name: "CA timestep" }).press("End");
  await expect(
    page.getByRole("region", { name: "Champion inspector" }),
  ).toContainText("2047 / 2047");
  await expect(page.getByText("3D view unavailable")).not.toBeVisible();
  await expect(dialog).not.toBeVisible();
  await screenArtifact(page, testInfo, "default-deep-preview");
  const mutations = observations.get(page)!.mutations.length;
  await expect(page.getByLabel("Time scale", { exact: true })).toContainText(
    "Time 1:1 · Every step · t 0–2047",
  );
  await page.getByRole("button", { name: "Inspector view options" }).click();
  const compression = page.getByRole("checkbox", { name: "Compress time" });
  await expect(compression).not.toBeChecked();
  await compression.check();
  await expect(page.getByLabel("Time scale", { exact: true })).toContainText(
    "Time compressed",
  );
  await compression.uncheck();
  await page
    .getByRole("spinbutton", { name: "Preview start timestep" })
    .fill("17");
  await page
    .getByRole("spinbutton", { name: "Preview end timestep" })
    .fill("49");
  const windowed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/preview") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const windowResponse = await windowed;
  expect(windowResponse.ok()).toBe(true);
  const window = await windowResponse.json();
  expect(window.layerTimes).toEqual(
    Array.from({ length: 33 }, (_, i) => i + 17),
  );
  expect(window.simulation.population).toEqual(frame.simulation.population);
  await expect(page.getByLabel("Time scale", { exact: true })).toContainText(
    "Every step · t 17–49",
  );
  const restored = page.waitForResponse(
    (response) =>
      response.url().endsWith("/preview") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Full horizon" }).click();
  expect((await restored).ok()).toBe(true);
  await expect(page.getByLabel("Time scale", { exact: true })).toContainText(
    "Every step · t 0–2047",
  );
  await page.getByRole("button", { name: "Inspector view options" }).click();
  expect(observations.get(page)!.mutations).toHaveLength(mutations);
});

test("a VM population continues while its only browser is closed, restores, pauses and steps exactly once", async ({
  page,
  context,
  request,
}, testInfo) => {
  const run = await createRun(page, testInfo, true);
  await expect
    .poll(
      async () => (await detail(request, run.summary.id)).summary.generation,
    )
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator("canvas")).toBeVisible();
  const beforeClosing = await detail(request, run.summary.id);
  const mutationCount = observations.get(page)!.mutations.length;
  await page.close();
  await expect
    .poll(
      async () => (await detail(request, run.summary.id)).summary.generation,
    )
    .toBeGreaterThan(beforeClosing.summary.generation);
  expect((await detail(request, run.summary.id)).summary.status).toBe(
    "running",
  );
  expect(observations.get(page)!.mutations).toHaveLength(mutationCount);
  const returned = await context.newPage();
  await open(returned);
  await expect(
    returned.getByRole("button", {
      name: `Select run ${run.config.name}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await returned
    .getByRole("button", { name: "Pause run", exact: true })
    .click();
  await waitForPaused(returned, request, run.summary.id);
  const paused = await detail(request, run.summary.id);
  await returned.waitForTimeout(350);
  expect((await detail(request, run.summary.id)).summary.generation).toBe(
    paused.summary.generation,
  );
  const advanced = await step(returned, request, run.summary.id);
  expect(advanced.snapshot!.population).toHaveLength(8);
  expect(advanced.summary.evaluations).toBeGreaterThanOrEqual(
    paused.summary.evaluations,
  );
  await returned.reload();
  await expect(
    returned.getByRole("button", { name: "Start run", exact: true }),
  ).toBeEnabled();
  expect((await detail(request, run.summary.id)).summary.generation).toBe(
    advanced.summary.generation,
  );
  await expect(
    returned
      .getByRole("table", { name: "Population ranked by training fitness" })
      .getByRole("row"),
  ).toHaveCount(9);
  await expect(returned.locator("canvas")).toBeVisible();
  const viewport = (await returned.locator("canvas").boundingBox())!;
  expect(viewport.width).toBeGreaterThan(900);
  expect(viewport.height).toBeGreaterThan(350);
  await screenArtifact(returned, testInfo, "restored-persistent-population");
});

test("Fork edits parameters for a fresh run while checkpoint import retains exact progress", async ({
  page,
  request,
}, testInfo) => {
  const original = await createRun(page, testInfo, false, {
    initialization: "random",
    incentives: [
      presetIncentive("lightExposure"),
      presetIncentive("avoidRepeatedReuse"),
    ],
  });
  await expect(page.getByRole("button", { name: "Fork run" })).toBeEnabled();
  await step(page, request, original.summary.id);
  await step(page, request, original.summary.id);
  const exported = await exportThroughUI(page, testInfo);
  expect(exported.checkpoint).toMatchObject({
    format: "polyp-research-checkpoint",
    version: 1,
    modelVersion: "ca-moore-research-v3",
    sourceRunId: original.summary.id,
  });
  expect(exported.checkpoint.state?.population).toHaveLength(8);
  const posts = observations.get(page)!.mutations.length;
  await page.getByRole("button", { name: "Fork run" }).click();
  let creator = page.getByRole("dialog", { name: "Fork run", exact: true });
  await creator.getByLabel("Edit configuration JSON").click();
  const copied = JSON.parse(
    await creator.getByLabel("Configuration JSON").inputValue(),
  );
  // A fork is a new independent search: every parameter copies except the seed.
  expect(copied).toEqual({
    ...original.config,
    name: `${original.config.name} (fork)`,
    randomSeed: copied.randomSeed,
  });
  expect(copied.randomSeed).not.toBe(original.config.randomSeed);
  expect(observations.get(page)!.mutations).toHaveLength(posts);
  await creator.getByLabel("Close run configuration").click();
  expect(observations.get(page)!.mutations).toHaveLength(posts);
  await page.getByRole("button", { name: "Fork run" }).click();
  creator = page.getByRole("dialog", { name: "Fork run", exact: true });
  await section(creator, "Starting worlds");
  await creator.getByLabel("CA horizon", { exact: true }).fill("40");
  await section(creator, "Search");
  await creator.getByLabel("Mutation beta", { exact: true }).fill("2");
  const replay = creator.getByRole("button", { name: "Use source seed" });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(
    creator.getByLabel("Search RNG seed", { exact: true }),
  ).toHaveValue(String(original.config.randomSeed));
  await expect(replay).toBeDisabled();
  await section(creator, "Goal");
  await creator.getByLabel("Incentive 2 weight").fill("3");
  await screenArtifact(page, testInfo, "editable-fork-parameters");
  const creating = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );
  await creator
    .getByRole("button", { name: "Create paused", exact: true })
    .click();
  const forkResponse = await creating;
  expect(forkResponse.status()).toBe(201);
  const fork = (await forkResponse.json()) as RunDetail;
  createdIds.add(fork.summary.id);
  expect(fork.config).toEqual({
    ...copied,
    steps: 40,
    mutationBeta: 2,
    randomSeed: original.config.randomSeed,
    incentives: [copied.incentives[0], { ...copied.incentives[1], weight: 3 }],
  });
  expect(fork.summary).toMatchObject({
    parentRunId: null,
    status: "paused",
    generation: -1,
  });
  expect(fork.snapshot).toBeNull();
  expect(fork.history).toEqual([]);
  expect(fork.improvements).toEqual([]);
  expect((await checkpoint(request, fork.summary.id)).state).toBeNull();
  const fresh = await step(page, request, fork.summary.id);
  expect(fresh.summary.generation).toBe(0);
  expect(
    fresh.snapshot!.population.every(
      (item) => item.birthGeneration === 0 && item.parents.length === 0,
    ),
  ).toBe(true);
  expect(
    observations.get(page)!.mutations.some((path) => path.endsWith("/fork")),
  ).toBe(false);
  expect((await detail(request, original.summary.id)).summary.generation).toBe(
    exported.checkpoint.state!.generation,
  );
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import checkpoint", exact: true })
    .click();
  const importing = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs/import") &&
      response.request().method() === "POST",
  );
  await (await chooser).setFiles(exported.path);
  const importedResponse = await importing;
  expect(importedResponse.status()).toBe(201);
  const imported = (await importedResponse.json()) as RunDetail;
  createdIds.add(imported.summary.id);
  expect(imported.summary).toMatchObject({
    status: "paused",
    generation: exported.checkpoint.state!.generation,
  });
  expect(imported.summary.id).not.toBe(original.summary.id);
  const importedState = (await checkpoint(request, imported.summary.id)).state!;
  expect(importedState.population).toEqual(
    exported.checkpoint.state!.population,
  );
  expect(importedState.rngState).toBe(exported.checkpoint.state!.rngState);
  await waitForPaused(page, request, imported.summary.id);
  const importedNext = await step(page, request, imported.summary.id);
  await page
    .getByRole("button", {
      name: `Select run ${original.config.name}`,
      exact: true,
      pressed: false,
    })
    .click();
  await waitForPaused(page, request, original.summary.id);
  const originalNext = await step(page, request, original.summary.id);
  expect(importedNext.snapshot).toEqual(originalNext.snapshot);
  expect((await checkpoint(request, imported.summary.id)).state!.rngState).toBe(
    (await checkpoint(request, original.summary.id)).state!.rngState,
  );
  await page.getByRole("tab", { name: "Compare", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Add comparison run" })
    .selectOption(fork.summary.id);
  await expect(
    page.getByRole("img", { name: "Best fitness comparison by selected run" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Remove ${fork.summary.name} from comparison`,
      exact: true,
    }),
  ).toBeVisible();
  await screenArtifact(page, testInfo, "fresh-fork-comparison");
});

test("finite run exposes real ancestry, retained generations, CA closeups and immutable parameters", async ({
  page,
  request,
}, testInfo) => {
  const run = await createRun(page, testInfo, true, {
    seed: "islands",
    trainingSeeds: [11, 22],
    validationSeeds: [33],
    maxGenerations: 3,
    mutationRate: 0.3,
  });
  await expect
    .poll(async () => (await detail(request, run.summary.id)).summary.status)
    .toBe("completed");
  const complete = await detail(request, run.summary.id);
  expect(complete.summary.generation).toBe(3);
  expect(complete.history).toHaveLength(4);
  expect(complete.snapshot!.population).toHaveLength(8);
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeDisabled();
  const offspring = complete.snapshot!.population.find(
    (individual) => individual.parents.length && individual.mutatedLoci.length,
  )!;
  expect(offspring).toBeDefined();
  await page
    .getByRole("row", { name: new RegExp(`individual ${offspring.id},`) })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Inspected candidate" }),
  ).toHaveValue("selected");
  await page.getByRole("tab", { name: "Genetics", exact: true }).click();
  const genetics = page.getByRole("region", {
    name: "Genetics and immediate ancestry",
  });
  for (const parent of offspring.parents)
    await expect(genetics).toContainText(parent.id);
  await expect(genetics).toContainText(
    `Mutated loci ${offspring.mutatedLoci.length}`,
  );
  await expect(
    page.getByText("Evaluating preview…", { exact: true }),
  ).toBeHidden();
  await screenArtifact(page, testInfo, "recorded-genetics");
  await page
    .getByRole("checkbox", { name: "Population allele frequencies" })
    .check();
  await expect(
    page.getByRole("img", {
      name: "Allele frequencies for each of 45 loci and 5 output states",
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Retained generation" })
    .selectOption("0");
  await page.getByRole("tab", { name: "Population", exact: true }).click();
  await expect(
    page.getByText("Generation 0 · 8 individuals · fitness descending"),
  ).toBeVisible();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const chart = page.getByRole("img", { name: /Fitness by GA generation/ });
  await chart.focus();
  await chart.press("ArrowRight");
  await chart.press("Enter");
  await expect(
    page.getByRole("combobox", { name: "Retained generation" }),
  ).toHaveValue("1");
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Retained generation" }),
  ).toHaveValue("latest");
  await screenArtifact(page, testInfo, "fitness-history");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("slider", { name: "CA timestep" })).toBeEnabled();
  const mutations = observations.get(page)!.mutations.length;
  await page.getByRole("button", { name: "Inspector view options" }).click();
  await page
    .getByRole("combobox", { name: "Preview display" })
    .selectOption("slice");
  const slider = page.getByRole("slider", { name: "CA timestep" });
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("1");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await page
    .getByRole("combobox", { name: "Palette", exact: true })
    .selectOption("ember");
  await page.getByRole("button", { name: "Reset specimen camera" }).click();
  await page.getByRole("button", { name: "Focus champion" }).click();
  await expect(
    page.getByRole("complementary", { name: "Run registry" }),
  ).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await screenArtifact(page, testInfo, "focused-ca-closeup");
  expect(observations.get(page)!.mutations).toHaveLength(mutations);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Parameters", exact: true }).click();
  expect(
    JSON.parse((await page.getByLabel("Run configuration").textContent())!),
  ).toEqual(run.config);
  await page.getByRole("button", { name: "New variant from champion" }).click();
  const variant = page.getByRole("dialog", {
    name: "New variant from champion",
  });
  await section(variant, "Search");
  await expect(
    variant.getByLabel("Initialization", { exact: true }),
  ).toHaveValue("mutants");
  await variant
    .getByRole("spinbutton", { name: "Mutation beta", exact: true })
    .fill("2.5");
  await variant
    .getByRole("button", { name: "Close run configuration" })
    .click();
  expect((await detail(request, run.summary.id)).config).toEqual(run.config);
});

test("mobile controls create and inspect a real run without a clipped configuration dialog", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const run = await createRun(page, testInfo, false, { maxGenerations: 2 });
  await step(page, request, run.summary.id);
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByRole("button", { name: "Focus champion" }).click();
  await expect(
    page.getByRole("button", { name: "Exit focus view" }),
  ).toBeVisible();
  // R3F resizes on the next ResizeObserver frame after focus expands the pane.
  await expect
    .poll(async () => (await page.locator("canvas").boundingBox())?.height ?? 0)
    .toBeGreaterThan(600);
  const canvas = (await page.locator("canvas").boundingBox())!;
  expect(canvas.width).toBeGreaterThan(300);
  expect(canvas.height).toBeGreaterThan(600);
  expect(canvas.x).toBeGreaterThanOrEqual(0);
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(391);
  await screenArtifact(page, testInfo, "mobile-focused-inspector");
  await page.getByRole("button", { name: "Exit focus view" }).click();
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  // Sections stack: the navigation, a section and the summary all fit.
  await expect(
    dialog.getByRole("complementary", { name: "Experiment summary" }),
  ).toBeInViewport();
  await section(dialog, "Budget");
  await dialog
    .getByRole("spinbutton", { name: "CPU workers", exact: true })
    .fill("1");
  await expect(
    dialog.getByRole("button", { name: "Create paused", exact: true }),
  ).toBeInViewport();
  await screenArtifact(page, testInfo, "mobile-configuration");
  await dialog.getByRole("button", { name: "Close run configuration" }).click();
  expect((await detail(request, run.summary.id)).summary.generation).toBe(0);
});

for (const stateCount of [2, 16]) {
  test(`${stateCount}-state controls create a real run and expose all rule rows and alleles`, async ({
    page,
    request,
  }, testInfo) => {
    await page
      .getByRole("button", { name: "New run", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New run", exact: true });
    await section(dialog, "Starting worlds");
    await dialog
      .getByRole("combobox", { name: "State count", exact: true })
      .selectOption(String(stateCount));
    await dialog
      .getByRole("combobox", { name: "Simulation scale", exact: true })
      .selectOption("quick");
    await section(dialog, "Budget");
    await dialog
      .getByRole("spinbutton", { name: "CPU workers", exact: true })
      .fill("1");
    await dialog
      .getByRole("spinbutton", { name: "Generation limit", exact: true })
      .fill("1");
    await section(dialog, "Search");
    await dialog
      .getByLabel("Initialization", { exact: true })
      .selectOption("mutants");
    if (stateCount === 2)
      await dialog
        .getByRole("combobox", { name: "Founder preset", exact: true })
        .selectOption("life");
    await dialog
      .getByRole("spinbutton", { name: "Population", exact: true })
      .fill("8");
    await dialog
      .getByRole("button", {
        name: `Edit ${stateCount * 9} outputs`,
        exact: true,
      })
      .click();
    const editor = page.getByRole("dialog", { name: "Rule", exact: true });
    await expect(
      editor.getByRole("button", { name: /^State \d+, \d+ neighbors:/ }),
    ).toHaveCount(stateCount * 9);
    const last = editor.getByRole("button", {
      name: new RegExp(`^State ${stateCount - 1}, 8 neighbors:`),
    });
    await last.click();
    await expect(last).toBeVisible();
    await screenArtifact(page, testInfo, `${stateCount}-state-rule-editor`);
    await editor.getByRole("button", { name: "Apply", exact: true }).click();
    const creating = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Create paused", exact: true })
      .click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const run = (await response.json()) as RunDetail;
    createdIds.add(run.summary.id);
    expect(run.config.stateCount).toBe(stateCount);
    expect(run.config.seedGenome).toHaveLength(stateCount * 9);
    await waitForPaused(page, request, run.summary.id);
    await step(page, request, run.summary.id);
    await page.getByRole("tab", { name: "Population", exact: true }).click();
    await expect(
      page.getByLabel(`${stateCount * 9} rule outputs`, { exact: true }),
    ).toHaveCount(8);
    await page.getByRole("tab", { name: "Genetics", exact: true }).click();
    const matrix = page.getByRole("table", {
      name: "Selected rule: current state by active Moore neighbors",
    });
    await expect(matrix.getByRole("row")).toHaveCount(stateCount + 1);
    await page
      .getByRole("checkbox", {
        name: "Population allele frequencies",
        exact: true,
      })
      .check();
    await expect(
      page.getByRole("img", {
        name: `Allele frequencies for each of ${stateCount * 9} loci and ${stateCount} output states`,
      }),
    ).toBeVisible();
    await screenArtifact(page, testInfo, `${stateCount}-state-genetics`);
    expect((await checkpoint(request, run.summary.id)).config.stateCount).toBe(
      stateCount,
    );
  });
}

test("compact carousel centers visible specimens, culls offscreen models, and coordinates navigation", async ({
  page,
  request,
}, testInfo) => {
  const preset = PRESETS.find((value) => value.id === "dendrite")!;
  const run = await createRun(page, testInfo, false, {
    stateCount: 5,
    seed: preset.seed,
    seedGenome: preset.genome,
    initialization: "mutants",
    mutationRate: 0.01,
    objective: "complexity",
    boundaryPolicy: { spatial: false, horizon: false },
  });
  const initialized = await step(page, request, run.summary.id);
  const mutations = observations.get(page)!.mutations.length;
  await page.getByLabel("Inspected candidate").selectOption("generation");
  await page.getByRole("button", { name: "Freeze population view" }).click();
  const gallery = page.getByRole("listbox", { name: "3D model gallery" });
  const options = gallery.getByRole("option");
  await expect(options).toHaveCount(initialized.snapshot!.population.length);
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Gallery position")).toHaveText("8 / 8");
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(gallery.locator('[data-rendered="true"]')).toHaveCount(5);
  const hostWidth = (await gallery.boundingBox())!.width;
  const slotWidth = (await options.last().boundingBox())!.width;
  expect(slotWidth).toBeCloseTo(hostWidth / 5, 0);
  expect(slotWidth).toBeLessThan(260);
  await expect(options.first()).toHaveAttribute("data-rendered", "false");
  await expect(options.last()).toHaveAttribute(
    "data-presentation",
    "interactive-3d",
  );
  await expect(options.nth(3)).toHaveAttribute(
    "data-presentation",
    "flat-projection",
  );
  const modelArea = (await options
    .last()
    .locator(".model-view")
    .boundingBox())!;
  const slotArea = (await options.last().boundingBox())!;
  expect(modelArea.height).toBe(slotArea.height);
  expect(modelArea.y).toBe(slotArea.y);

  // Inspect actual rendered pixels, not just correctly placed DOM boxes. This
  // catches a fresh camera looking at y=0 and cropping a specimen at its base.
  async function expectCentered(index: number) {
    const viewport = options.nth(index).locator(".model-view");
    const bounds = (await viewport.boundingBox())!;
    const host = (await gallery.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(host.x - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      host.x + host.width + 1,
    );
    const screenshot = await viewport.screenshot();
    const pixels = await page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let left = image.width,
        right = 0,
        top = image.height,
        bottom = 0,
        count = 0;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          if (
            data[i] > 45 &&
            data[i] > data[i + 1] * 1.15 &&
            data[i] > data[i + 2] * 1.1
          ) {
            count++;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return {
        count,
        x: (left + right) / (2 * image.width),
        y: (top + bottom) / (2 * image.height),
        top: top / image.height,
        bottom: bottom / image.height,
      };
    }, screenshot.toString("base64"));
    expect(pixels.count).toBeGreaterThan(20);
    expect(pixels.x).toBeGreaterThan(0.35);
    expect(pixels.x).toBeLessThan(0.65);
    expect(pixels.y).toBeGreaterThan(0.35);
    expect(pixels.y).toBeLessThan(0.65);
    expect(pixels.top).toBeGreaterThan(0.015);
    expect(pixels.bottom).toBeLessThan(0.985);
  }
  for (const index of [3, 5, 7]) await expectCentered(index);
  // Model clicks select candidates without cutting away their time history.
  const timeline = page.getByRole("slider", { name: "CA timestep" });
  const fullDepth = await timeline.inputValue();
  for (const material of ["points", "voxels"]) {
    await page.getByRole("button", { name: "Inspector view options" }).click();
    await page.getByLabel("Render material").selectOption(material);
    await page.getByRole("button", { name: "Inspector view options" }).click();
    const model = (await options.last().locator(".model-view").boundingBox())!;
    await page.mouse.click(
      model.x + model.width / 2,
      model.y + model.height / 2,
    );
    await expect(timeline).toHaveValue(fullDepth);
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
  }
  await timeline.press("ArrowLeft");
  await expect(timeline).toHaveValue(String(Number(fullDepth) - 1));
  await timeline.press("End");
  await expect(timeline).toHaveValue(fullDepth);
  await screenArtifact(page, testInfo, "compact-model-carousel");
  await gallery.press("Home");
  await expect(gallery.locator('[data-rendered="true"]')).toHaveCount(5);
  await expect(options.first()).toHaveAttribute("data-rendered", "true");
  await expect(options.last()).toHaveAttribute("data-rendered", "false");
  // Native horizontal scrolling must load the actual viewport, even before
  // the selection catches up, and release the models that left it.
  const area = (await gallery.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(slotWidth * 2, 0);
  await expect(options.first()).toHaveAttribute("data-rendered", "false");
  await expect(options.nth(6)).toHaveAttribute("data-rendered", "true");
  await gallery.press("End");
  await expect(options.last()).toHaveAttribute("data-rendered", "true");
  await expect(gallery.locator('[data-rendered="true"]')).toHaveCount(5);
  await options.nth(6).click();
  await expect(options.nth(6)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Inspected candidate")).toHaveValue(
    "generation",
  );
  await gallery.press("ArrowLeft");
  await expect(page.getByLabel("Gallery position")).toHaveText("6 / 8");
  const identity = await options.nth(5).getAttribute("aria-label");
  await page.getByRole("tab", { name: "Genetics", exact: true }).click();
  const candidateId = identity!.split(": ")[1].split(",")[0];
  await expect(
    page.getByRole("region", { name: "Genetics and immediate ancestry" }),
  ).toContainText(candidateId);
  await gallery.press("End");
  await expect(page.getByLabel("Gallery position")).toHaveText("8 / 8");
  // A wide registry + short inspector used to cull the rightmost view using
  // page coordinates as if the canvas began at the viewport's top-left.
  const registry = page.getByRole("separator", {
    name: "Resize run registry",
    exact: true,
  });
  await registry.focus();
  for (let i = 0; i < 10; i++) await registry.press("ArrowRight");
  const divider = page.getByRole("separator", {
    name: "Resize analysis and inspector",
    exact: true,
  });
  await divider.focus();
  for (let i = 0; i < 5; i++) await divider.press("ArrowUp");
  await expectCentered(7);
  await page.getByLabel("Inspected candidate").selectOption("best");
  await expect(options).toHaveCount(initialized.improvements.length);
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  expect(observations.get(page)!.mutations).toHaveLength(mutations);
  await screenArtifact(page, testInfo, "centered-model-carousel");
});

test("soup carousel cycles fixtures with adjustable speed and stable canvas overlays", async ({
  page,
  request,
}, testInfo) => {
  const run = await createRun(
    page,
    testInfo,
    false,
    {
      seed: "soup",
      soupSize: 6,
      objective: "finiteDense",
      steps: 32,
      trainingSeeds: [1729, 1730],
      validationSeeds: [2718],
    },
    true,
  );
  await step(page, request, run.summary.id);
  const fixture = page.getByLabel("Starting configuration");
  const canvas = page.locator(".champion-canvas");
  const selector = page.getByLabel("Preview fixture");
  await expect(page.getByLabel("Pause CA playback")).toBeEnabled();
  await page.getByLabel("Pause CA playback").click();
  await page.getByLabel("Preview fixture").selectOption("1729");
  await expect(page.getByLabel("Loop animation")).toBeChecked();
  await expect(page.getByLabel("Animation speed")).toHaveValue("4");
  await expect(fixture).toContainText("Soup 6 × 6");
  const before = (await canvas.boundingBox())!;
  const position = (await fixture.boundingBox())!;
  expect(position.x).toBeGreaterThan(before.x + before.width / 2);
  expect(position.y).toBeGreaterThanOrEqual(before.y);
  expect(position.y).toBeLessThan(before.y + 16);
  expect(position.x + position.width).toBeGreaterThan(
    before.x + before.width - 20,
  );
  // Slow enough to observe a whole lap reliably even under software WebGL.
  await page.getByLabel("Animation speed").selectOption("1");
  await page.getByLabel("Play CA history").click();
  const genomes: number[][] = [];
  for (const seed of [1730, 2718, 1729]) {
    const response = await page.waitForResponse((response) => {
      if (!response.url().endsWith(`/runs/${run.summary.id}/preview`))
        return false;
      const input = response.request().postDataJSON();
      return input.seed === seed;
    });
    expect(response.ok()).toBe(true);
    genomes.push(response.request().postDataJSON().genome);
    await expect(selector).toHaveValue(String(seed));
  }
  expect(genomes[1]).toEqual(genomes[0]);
  expect(genomes[2]).toEqual(genomes[0]);
  await page.getByLabel("Pause CA playback").click();
  await page.getByLabel("Inspected candidate").selectOption("generation");
  await page.getByLabel("Previous model").click();
  await expect(fixture).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  await screenArtifact(page, testInfo, "soup-fixture-header");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fixture).toBeVisible();
  const mobileFixture = (await fixture.boundingBox())!;
  expect(mobileFixture.x).toBeGreaterThanOrEqual(0);
  expect(mobileFixture.x + mobileFixture.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await screenArtifact(page, testInfo, "soup-fixture-mobile");
});

test("sidebar context menu starts and stops a different run without moving selection", async ({
  page,
  request,
}, testInfo) => {
  const first = await createRun(page, testInfo, false, {
    name: "Context target",
  });
  const second = await createRun(page, testInfo, false, {
    name: "Context observer",
  });
  const row = page.getByRole("button", {
    name: "Select run Context target",
    exact: true,
  });
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Stop", exact: true }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "Start", exact: true }).click();
  await expect
    .poll(async () => (await detail(request, first.summary.id)).summary.status)
    .toBe("running");
  await expect(
    page.getByRole("button", {
      name: "Select run Context observer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await expect
    .poll(async () => (await detail(request, first.summary.id)).summary.status)
    .toBe("paused");
  expect((await detail(request, second.summary.id)).summary.generation).toBe(
    -1,
  );
});

test("weighted custom incentives are edited safely and scored by the VM", async ({
  page,
  request,
}, testInfo) => {
  await open(page);
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  await expect(dialog.getByLabel("Objective", { exact: true })).toHaveCount(0);
  const scoring = dialog.getByRole("group", {
    name: "Scoring incentives",
    exact: true,
  });
  await expect(
    scoring.getByLabel("Disqualify spatial edge contact"),
  ).toBeChecked();
  await expect(
    scoring.getByLabel("Disqualify time cutoff contact"),
  ).toBeChecked();
  await dialog.getByLabel("Edit configuration JSON").click();
  const json = dialog.getByLabel("Configuration JSON");
  // Every contender must equal the all-zero founder, so mutation is switched
  // off under the independent policy (heavy-tailed always changes a locus).
  const { mutationBeta: _beta, ...defaults } = JSON.parse(
    await json.inputValue(),
  );
  void _beta;
  const config = {
    ...defaults,
    initialization: "mutants",
    name: `e2e-incentives-${Date.now()}`,
    size: 9,
    steps: 8,
    seed: "point",
    seedGenome: Array(45).fill(0),
    populationSize: 8,
    eliteCount: 2,
    mutationPolicy: "independent",
    mutationRate: 0,
    immigrantRate: 0,
    evaluationWorkers: 1,
  };
  await json.fill(JSON.stringify(config));
  await dialog.getByLabel("Use parameter fields").click();
  await scoring
    .getByLabel("Add incentive", { exact: true })
    .selectOption("new");
  let editor = page.getByRole("dialog", { name: "New incentive", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByLabel("Incentive name").fill("Occupied volume");
  await editor.getByLabel("Math formula").fill("globalThis.process.exit()");
  await expect(
    editor.getByRole("button", { name: "Add incentive", exact: true }),
  ).toBeDisabled();
  await editor.getByLabel("Math formula").fill("");
  await editor.getByRole("button", { name: "occupancy", exact: true }).click();
  await expect(editor.getByLabel("Math formula")).toHaveValue("occupancy");
  await editor.getByLabel("Math formula").fill("");
  await editor.getByRole("button", { name: "reuseAlive", exact: true }).click();
  await expect(editor.getByLabel("Math formula")).toHaveValue("reuseAlive");
  await expect(editor.getByRole("status")).toHaveText("Valid formula");
  await editor
    .getByLabel("Math formula")
    .fill("(exposedCells / area) / (1 + reuseEvents)");
  await expect(editor.getByRole("status")).toHaveText("Valid formula");
  await screenArtifact(page, testInfo, "custom-incentive-editor");
  await editor
    .getByRole("button", { name: "Add incentive", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await expect(
    scoring.getByLabel("Add incentive", { exact: true }),
  ).toBeFocused();
  await scoring.getByLabel("Incentive 2 weight").fill("3");
  await expect(
    scoring.getByRole("list", { name: "Scoring incentives" }),
  ).toContainText("75.0%");
  await scoring
    .getByLabel("Add incentive", { exact: true })
    .selectOption("lightExposure");
  await expect(
    scoring.getByRole("list", { name: "Scoring incentives" }),
  ).toContainText("Light exposure");
  await scoring
    .getByRole("button", { name: "Remove incentive 3: Light exposure" })
    .click();
  await scoring
    .getByLabel("Add incentive", { exact: true })
    .selectOption("avoidRepeatedReuse");
  await expect(
    scoring.getByRole("list", { name: "Scoring incentives" }),
  ).toContainText("1 / (1 + reuseEvents)");
  await expect(scoring).toContainText(
    "Continuous survival and changes between live types do not count.",
  );
  await scoring
    .getByRole("button", { name: "Remove incentive 3: Avoid reuse after death" })
    .click();
  await scoring
    .getByLabel("Add incentive", { exact: true })
    .selectOption("avoidReuseAlive");
  await expect(
    scoring.getByRole("list", { name: "Scoring incentives" }),
  ).toContainText("1 / (1 + reuseAlive)");
  await expect(scoring).toContainText(
    "Continuous survival, changes between live types and returns after death all count.",
  );
  await screenArtifact(page, testInfo, "any-cell-reuse-incentive");
  // A nested modal must contain keyboard focus and Escape must preserve the run draft.
  await scoring
    .getByLabel("Add incentive", { exact: true })
    .selectOption("new");
  editor = page.getByRole("dialog", { name: "New incentive", exact: true });
  await editor.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(editor.getByLabel("Close incentive editor")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await scoring
    .getByRole("button", { name: "Edit incentive 2: Occupied volume" })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Edit incentive",
    exact: true,
  });
  await expect(
    edit.getByRole("button", { name: "Save incentive" }),
  ).toBeInViewport();
  const bounds = (await edit.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await screenArtifact(page, testInfo, "mobile-incentive-editor");
  await edit.getByRole("button", { name: "Save incentive" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create paused", exact: true })
    .click();
  const response = await created;
  expect(response.status()).toBe(201);
  const run = (await response.json()) as RunDetail;
  createdIds.add(run.summary.id);
  expect(run.config.incentives).toEqual([
    presetIncentive("longevity"),
    {
      name: "Occupied volume",
      expression: "(exposedCells / area) / (1 + reuseEvents)",
      weight: 3,
    },
    presetIncentive("avoidReuseAlive"),
  ]);
  const evaluated = await step(page, request, run.summary.id);
  const expected = (1 / 7 + 3 / 81 + 1) / 5;
  expect(evaluated.snapshot!.champion.fitness).toBeCloseTo(expected, 14);
  const saved = await checkpoint(request, run.summary.id);
  expect(saved.config.incentives).toEqual(run.config.incentives);
  expect(saved.state!.champion.fitness).toBeCloseTo(expected, 14);
});
