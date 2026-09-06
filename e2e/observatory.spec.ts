import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type FileChooser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type {
  EvolutionCommand,
  EvolutionRequest,
  EvolutionResponse,
  SnapshotMessage,
} from "../src/protocol";
import type { Experiment } from "../src/experiment";
import { evolve, genomeId, PRESETS } from "../src/simulation";

interface Observation {
  errors: string[];
  sent: EvolutionCommand[];
  received: EvolutionResponse[];
  browserWorkers: string[];
}
const observations = new WeakMap<Page, Observation>();
const observed = (page: Page) => observations.get(page)!;
const latestSnapshot = (page: Page) =>
  observed(page)
    .received.filter(
      (message): message is SnapshotMessage => message.type === "snapshot",
    )
    .at(-1)!;

// Actual Chromium, WebGL, WebSocket transport, and Node worker_threads. We only
// observe wire frames; every state change uses native controls or file choosers.
// The Playwright webServer health URL must reach the API, not just Vite's HTML.
test.beforeEach(async ({ page, request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    status: "ok",
    execution: "node:worker_threads",
  });
  const observation: Observation = {
    errors: [],
    sent: [],
    received: [],
    browserWorkers: [],
  };
  observations.set(page, observation);
  page.on("pageerror", (error) => observation.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") observation.errors.push(message.text());
  });
  page.on("worker", (worker) => observation.browserWorkers.push(worker.url()));
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/evolution")) return;
    socket.on("framesent", (event) =>
      observation.sent.push(JSON.parse(event.payload.toString())),
    );
    socket.on("framereceived", (event) =>
      observation.received.push(JSON.parse(event.payload.toString())),
    );
  });
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "VM connected" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test.afterEach(async ({ page }) => {
  expect(
    observed(page).errors,
    "No browser exceptions, shader failures, or console errors",
  ).toEqual([]);
  expect(
    observed(page).browserWorkers,
    "Science must execute on the VM, not browser Workers",
  ).toEqual([]);
});

async function openControls(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle controls" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
async function openDiagnostics(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle diagnostics" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
function metric(page: Page, name: string) {
  return page
    .getByRole("complementary", { name: "Diagnostics" })
    .locator("dt")
    .filter({ hasText: new RegExp(`^${name}$`) })
    .locator("..")
    .locator("dd");
}
async function smallWorld(page: Page) {
  await openControls(page);
  await page.getByRole("combobox", { name: "Grid size" }).selectOption("25");
  await page.getByRole("combobox", { name: "Time depth" }).selectOption("24");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("slider", { name: "Visible time layer" }),
  ).toHaveValue("24");
}
async function chooseFile(
  page: Page,
  file: Parameters<FileChooser["setFiles"]>[0],
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load experiment" }).click();
  await (await chooser).setFiles(file);
}
async function downloadExperiment(
  page: Page,
  testInfo: TestInfo,
  label: string,
) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save experiment" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^polyp-[A-F0-9]{8}\.json$/);
  const path = testInfo.outputPath(`${label}-${download.suggestedFilename()}`);
  await download.saveAs(path);
  const text = await readFile(path, "utf8");
  const experiment = JSON.parse(text) as Experiment;
  expect(download.suggestedFilename()).toBe(
    `polyp-${genomeId(experiment.genome)}.json`,
  );
  return { path, text, experiment };
}

test("default surface is an uncluttered full canvas with real VM provenance and hideable drawers", async ({
  page,
}, testInfo) => {
  await expect(page.getByRole("heading")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(
    page.getByText(
      /Small rules|Collection|Occupied \/ layer|State diversity|Lifetime/,
    ),
  ).toHaveCount(0);
  const canvas = (await page.locator("canvas").boundingBox())!;
  expect(canvas.width).toBeGreaterThan(1400);
  expect(canvas.height).toBeGreaterThan(950);
  const ready = observed(page).received.find(
    (message) => message.type === "ready",
  );
  expect(ready).toMatchObject({
    execution: { kind: "node:worker_threads", threadId: expect.any(Number) },
  });
  expect(latestSnapshot(page).execution.threadId).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("minimal-default.png") });
  await openControls(page);
  await expect(
    page.getByRole("complementary", { name: "Controls" }),
  ).toBeVisible();
  await page.getByText("Evolution", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Objective" })).toBeHidden();
  await page.getByText("Evolution", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Objective" })).toBeVisible();
  await openDiagnostics(page);
  await expect(
    page.getByRole("complementary", { name: "Controls" }),
  ).toHaveCount(0);
  await expect(metric(page, "Execution")).toHaveText(/VM \/ thread [1-9]\d*/);
  await expect(metric(page, "Epoch")).toHaveText("0");
  await expect(metric(page, "Rule")).toHaveText(genomeId(PRESETS[0].genome));
  await page
    .getByRole("button", { name: "Toggle diagnostics" })
    .press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("native Step, Run, Pause and changed inputs produce exact VM computation and quiescent revisions", async ({
  page,
}) => {
  await smallWorld(page);
  await page.getByRole("button", { name: "Step evolution" }).click();
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  const command = observed(page).sent.find(
    (message): message is EvolutionRequest => message.type === "step",
  )!;
  const snapshot = observed(page).received.find(
    (message): message is SnapshotMessage =>
      message.type === "snapshot" && message.id === command.id,
  )!;
  const expected = evolve(
    command.genome,
    command.config,
    command.objective,
    command.mutationRate,
    command.randomSeed,
  );
  expect(snapshot).toMatchObject({
    genome: expected.genome,
    config: command.config,
    epoch: 1,
    fitness: expected.fitness,
    randomSeed: command.randomSeed + 1,
    running: false,
  });
  expect(snapshot.simulation.layers).toEqual(
    expected.simulation.layers.map((layer) =>
      Buffer.from(layer).toString("base64"),
    ),
  );
  await openDiagnostics(page);
  await expect(metric(page, "Epoch")).toHaveText("1");
  await expect(metric(page, "Fitness")).toHaveText(expected.fitness.toFixed(5));
  await page.getByRole("button", { name: "Run evolution" }).click();
  await expect(
    page.getByRole("button", { name: "Pause evolution" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Step evolution" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("slider", { name: "Visible time layer" }),
  ).toBeDisabled();
  await expect
    .poll(async () => Number(await metric(page, "Epoch").textContent()))
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Pause evolution" }).click();
  const epoch = await metric(page, "Epoch").textContent();
  const rule = await metric(page, "Rule").textContent();
  await page.waitForTimeout(500); // More than one server epoch; pause cannot commit queued work.
  await expect(metric(page, "Epoch")).toHaveText(epoch!);
  await expect(metric(page, "Rule")).toHaveText(rule!);
  expect(observed(page).sent.at(-1)!.type).toBe("pause");
  await page.getByRole("button", { name: "Run evolution" }).click();
  await openControls(page);
  await page
    .getByRole("combobox", { name: "Seed pattern" })
    .selectOption("islands");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  await openDiagnostics(page);
  await expect(metric(page, "Epoch")).toHaveText("0");
  await page.waitForTimeout(500);
  await expect(metric(page, "Epoch")).toHaveText("0");
  expect(latestSnapshot(page)).toMatchObject({
    epoch: 0,
    running: false,
    config: { seed: "islands" },
  });
});

test("presets and initial conditions produce distinct actual histories, retaining dimensions", async ({
  page,
}) => {
  await smallWorld(page);
  const seen = new Set<string>();
  for (const preset of PRESETS) {
    await page
      .getByRole("combobox", { name: "Rule preset" })
      .selectOption(preset.id);
    await expect(
      page.getByRole("button", { name: "Run evolution" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("combobox", { name: "Seed pattern" }),
    ).toHaveValue(preset.seed);
    const snapshot = latestSnapshot(page);
    expect(snapshot).toMatchObject({
      genome: preset.genome,
      config: { size: 25, steps: 24, seed: preset.seed },
    });
    seen.add(snapshot.simulation.layers.join(""));
  }
  expect(seen.size).toBe(3);
  await page.getByRole("combobox", { name: "Grid size" }).selectOption("33");
  await page.getByRole("combobox", { name: "Time depth" }).selectOption("32");
  await page
    .getByRole("combobox", { name: "Rule preset" })
    .selectOption("pagoda");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Grid size" })).toHaveValue(
    "33",
  );
  await expect(
    page.getByRole("slider", { name: "Visible time layer" }),
  ).toHaveValue("32");
  expect(latestSnapshot(page).config).toMatchObject({
    size: 33,
    steps: 32,
    seed: "point",
  });
});

test("time scrubbing, playback and hidden timeline affect only the rendered history", async ({
  page,
}) => {
  await smallWorld(page);
  await page
    .getByRole("combobox", { name: "Rule preset" })
    .selectOption("pagoda");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  const commands = observed(page).sent.length;
  await openDiagnostics(page);
  const slider = page.getByRole("slider", { name: "Visible time layer" });
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("1");
  await expect(metric(page, "Occupied / layer")).toHaveText("1");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await expect(metric(page, "Occupied / layer")).toHaveText(
    String(latestSnapshot(page).simulation.population[1]),
  );
  await slider.press("End");
  await page.getByRole("button", { name: "Play time" }).click();
  await expect(page.getByRole("button", { name: "Pause time" })).toBeVisible();
  await expect(slider).not.toHaveValue("1");
  await page.getByRole("button", { name: "Pause time" }).click();
  const paused = await slider.inputValue();
  await page.waitForTimeout(300);
  await expect(slider).toHaveValue(paused);
  await openControls(page);
  await page.getByText("View", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Timeline", exact: true }).uncheck();
  await expect(slider).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Timeline", exact: true }).check();
  await expect(slider).toHaveValue(paused);
  expect(observed(page).sent).toHaveLength(commands);
});

test("the keyboard-accessible compact rule draft is quiescent, private, cancellable and persisted on Apply", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
  const original = await downloadExperiment(page, testInfo, "original");
  const edit = page.getByRole("button", { name: "Edit rule", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Rule", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close rule editor" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Apply", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close rule editor" }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: /^State \d, \d neighbors:/ }),
  ).toHaveCount(45);
  await expect(
    dialog.getByRole("button", { name: "State 0, 0 neighbors: next state 0" }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "State 0, 1 neighbors: next state 0" })
    .click();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "State 0, 1 neighbors: next state 2" }),
  ).toBeFocused();
  const sent = observed(page).sent.length;
  await page.keyboard.press(".");
  expect(observed(page).sent).toHaveLength(sent);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(edit).toBeFocused();
  expect(
    (await downloadExperiment(page, testInfo, "cancelled")).experiment,
  ).toEqual(original.experiment);
  await edit.click();
  await expect(
    dialog.getByRole("button", { name: "State 0, 1 neighbors: next state 0" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "State 0, 1 neighbors: next state 0" })
    .click();
  await page.screenshot({ path: testInfo.outputPath("compact-rule.png") });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  const custom = (await downloadExperiment(page, testInfo, "applied"))
    .experiment;
  const genome = [...original.experiment.genome];
  genome[1] = 1;
  expect(custom).toEqual({ ...original.experiment, genome, name: "Custom" });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  expect(
    (await downloadExperiment(page, testInfo, "restored")).experiment,
  ).toEqual(custom);
});

test("native file download and import preserve the exact experiment after a source change", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
  await page
    .getByRole("combobox", { name: "Rule preset" })
    .selectOption("pagoda");
  await page.getByRole("spinbutton", { name: "Initial seed" }).fill("2024");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  const original = await downloadExperiment(page, testInfo, "original");
  expect(original.experiment).toEqual({
    version: 1,
    name: "Pagoda",
    genome: PRESETS[1].genome,
    config: { size: 25, steps: 24, seed: "point", randomSeed: 2024 },
  });
  await page
    .getByRole("combobox", { name: "Rule preset" })
    .selectOption("archipelago");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Run evolution" }).click();
  await chooseFile(page, original.path);
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  const restored = await downloadExperiment(page, testInfo, "roundtrip");
  expect(restored.experiment).toEqual(original.experiment);
  // JSON object key order is not part of the portable experiment contract.
  expect(restored.text).toBe(JSON.stringify(restored.experiment, null, 2));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeEnabled();
  expect(
    (await downloadExperiment(page, testInfo, "reloaded")).experiment,
  ).toEqual(original.experiment);
});

test("invalid and oversized files cannot replace the accepted experiment", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
  const original = await downloadExperiment(page, testInfo, "original");
  await chooseFile(page, {
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":2}'),
  });
  await expect(page.getByRole("alert")).toContainText("valid 45-gene");
  await chooseFile(page, {
    name: "oversize.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(100_001, 32),
  });
  await expect(page.getByRole("alert")).toContainText("File exceeds 100 KB.");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await downloadExperiment(page, testInfo, "unchanged")).experiment,
  ).toEqual(original.experiment);
});

test("render tools, orbit drag and zoom are genuine pointer paths independent of computation", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
  await page.getByRole("button", { name: "Close panel" }).click();
  const canvas = page.locator("canvas");
  const original = await canvas.screenshot();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.45,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.65,
    bounds.y + bounds.height * 0.6,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(original))
    .toBe(false);
  await page.mouse.wheel(0, -120);
  const commands = observed(page).sent.length;
  await openControls(page);
  await page.getByText("View", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Reference grid" }),
  ).not.toBeChecked();
  await page
    .getByRole("combobox", { name: "Rendering" })
    .selectOption("points");
  await page.getByRole("combobox", { name: "Palette" }).selectOption("ember");
  await page.getByRole("checkbox", { name: "Dither / grain" }).uncheck();
  await page.getByRole("checkbox", { name: "Reference grid" }).check();
  await page.getByRole("button", { name: "Reset camera" }).click();
  await expect(page.getByRole("combobox", { name: "Rendering" })).toHaveValue(
    "points",
  );
  await expect(
    page.getByRole("checkbox", { name: "Dither / grain" }),
  ).not.toBeChecked();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(original))
    .toBe(false);
  expect(observed(page).sent).toHaveLength(commands);
  await page.screenshot({ path: testInfo.outputPath("render-tools.png") });
});

test("narrow-screen controls and rule editing remain visible without document overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await smallWorld(page);
  const controls = (await page
    .getByRole("complementary", { name: "Controls" })
    .boundingBox())!;
  expect(controls.x).toBeGreaterThanOrEqual(0);
  expect(controls.x + controls.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Edit rule", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rule", exact: true });
  await expect(
    dialog.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile-rule.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close panel" }).click();
  expect(
    await page.locator("body").evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
});
