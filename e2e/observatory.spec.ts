import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
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
    modelVersion: "ca-moore-research-v2",
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
  await editor.fill(JSON.stringify(config, null, 2));
  // Switching back verifies JSON is accepted by the same editable fields users use.
  await dialog.getByRole("button", { name: "Use parameter fields" }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "Grid size", exact: true }),
  ).toHaveValue(String(config.size));
  await expect(
    dialog.getByRole("spinbutton", { name: "Generation limit", exact: true }),
  ).toHaveValue(String(config.maxGenerations));
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

test("the default finite-longevity run uses deep scale and previews its full 2,048-timestep horizon", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  await expect(
    dialog.getByRole("spinbutton", { name: "Grid size", exact: true }),
  ).toHaveValue("129");
  await expect(
    dialog.getByRole("spinbutton", { name: "CA horizon", exact: true }),
  ).toHaveValue("2048");
  await expect(
    dialog.getByRole("combobox", { name: "Simulation scale" }),
  ).toHaveValue("deep");
  await expect(
    dialog.getByRole("combobox", { name: "Objective", exact: true }),
  ).toHaveValue("longevity");
  await expect(dialog).toContainText("Still alive at the cutoff scores zero");
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
  const frame = await frameResponse.json();
  expect(frame.totalSteps).toBe(2048);
  expect(frame.layerTimes.at(-1)).toBe(2047);
  await expect(
    page.getByRole("region", { name: "Champion inspector" }),
  ).toContainText("2047 / 2047");
  await expect(dialog).not.toBeVisible();
  await screenArtifact(page, testInfo, "default-deep-preview");
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

test("downloaded checkpoints and UI forks retain exact population, RNG and deterministic next generation", async ({
  page,
  request,
}, testInfo) => {
  const original = await createRun(page, testInfo);
  await step(page, request, original.summary.id); // Generation 0 is a full evaluation.
  await step(page, request, original.summary.id); // Generation 1 has recorded parents/mutations.
  const exported = await exportThroughUI(page, testInfo);
  expect(exported.checkpoint).toMatchObject({
    format: "polyp-research-checkpoint",
    version: 1,
    modelVersion: "ca-moore-research-v2",
    sourceRunId: original.summary.id,
  });
  expect(exported.checkpoint.state?.population).toHaveLength(8);
  const forking = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/runs/${original.summary.id}/fork`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Fork run" }).click();
  const forkResponse = await forking;
  expect(forkResponse.status()).toBe(201);
  const fork = (await forkResponse.json()) as RunDetail;
  createdIds.add(fork.summary.id);
  expect(fork.summary).toMatchObject({
    parentRunId: original.summary.id,
    status: "paused",
    generation: exported.checkpoint.state!.generation,
  });
  await waitForPaused(page, request, fork.summary.id);
  const forkState = (await checkpoint(request, fork.summary.id)).state!;
  expect(forkState.population).toEqual(exported.checkpoint.state!.population);
  expect(forkState.rngState).toBe(exported.checkpoint.state!.rngState);
  const forkNext = await step(page, request, fork.summary.id);
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
  expect(importedNext.snapshot).toEqual(forkNext.snapshot);
  expect((await checkpoint(request, imported.summary.id)).state!.rngState).toBe(
    (await checkpoint(request, fork.summary.id)).state!.rngState,
  );
  expect((await detail(request, original.summary.id)).summary.generation).toBe(
    exported.checkpoint.state!.generation,
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
  await screenArtifact(page, testInfo, "deterministic-fork-comparison");
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
  await variant
    .getByRole("spinbutton", { name: "Mutation probability", exact: true })
    .fill("0.07");
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
    await dialog
      .getByRole("combobox", { name: "State count", exact: true })
      .selectOption(String(stateCount));
    await dialog
      .getByRole("combobox", { name: "Simulation scale", exact: true })
      .selectOption("quick");
    if (stateCount === 2)
      await dialog
        .getByRole("combobox", { name: "Founder preset", exact: true })
        .selectOption("life");
    await dialog
      .getByRole("spinbutton", { name: "Population", exact: true })
      .fill("8");
    await dialog
      .getByRole("spinbutton", { name: "CPU workers", exact: true })
      .fill("1");
    await dialog
      .getByRole("spinbutton", { name: "Generation limit", exact: true })
      .fill("1");
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
