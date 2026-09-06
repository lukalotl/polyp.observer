import { readFile } from "node:fs/promises";
import { expect, test, type Page, type FileChooser } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>();

// Real application code, real WebGL and the real evolution worker. Every state
// change comes from native controls, pointer/keyboard input or the file chooser.
// A fresh Playwright context supplies an isolated specimen store for each test.
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Dendrite/ })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("THE VIEWPORT IS UNAVAILABLE")).not.toBeVisible();
  const genes = page
    .getByRole("button", { name: "Edit rule genome" })
    .locator(".gene");
  await expect(genes).toHaveCount(45);
  const widths = await genes.evaluateAll((cells) =>
    cells.map((cell) => cell.getBoundingClientRect().width),
  );
  expect(
    widths.every((width) => width > 0),
    "Every genotype output remains visibly represented",
  ).toBe(true);
});

test.afterEach(async ({ page }) => {
  expect(
    browserErrors.get(page),
    "No browser exceptions, shader failures or console errors",
  ).toEqual([]);
});

async function smallWorld(page: Page) {
  await page.getByRole("combobox", { name: "World size" }).selectOption("25");
  await page.getByRole("combobox", { name: "Time depth" }).selectOption("24");
}
function genotype(page: Page) {
  return page.locator(".gene-caption").getByText(/GENOTYPE/);
}
async function chooseFile(
  page: Page,
  file: Parameters<FileChooser["setFiles"]>[0],
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await chooser).setFiles(file);
}

test("presets and environment controls produce distinct, selectable histories", async ({
  page,
}) => {
  await smallWorld(page);
  const seen = new Set<string>();
  for (const [name, seed] of [
    ["Dendrite", "Cross"],
    ["Pagoda", "Point"],
    ["Archipelago", "Islands"],
  ]) {
    const preset = page.getByRole("button", {
      name: `Select ${name} specimen`,
    });
    await preset.click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: new RegExp(name) }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: seed, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("slider", { name: "Visible time layer" }),
    ).toHaveValue("24");
    seen.add((await genotype(page).textContent())!);
  }
  expect(seen.size).toBe(3);
  await page.getByRole("combobox", { name: "World size" }).selectOption("33");
  await page.getByRole("combobox", { name: "Time depth" }).selectOption("32");
  await expect(page.getByText("33 × 33 × 32", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select Pagoda specimen" }).click();
  await expect(page.getByRole("combobox", { name: "World size" })).toHaveValue(
    "33",
  );
  await expect(page.getByRole("combobox", { name: "Time depth" })).toHaveValue(
    "32",
  );
});

test("timeline supports keyboard scrubbing, playback, pausing and the whole history", async ({
  page,
}) => {
  await smallWorld(page);
  await page.getByRole("button", { name: "Select Pagoda specimen" }).click();
  const slider = page.getByRole("slider", { name: "Visible time layer" });
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("1");
  await expect(
    page.getByRole("region", { name: "Time explorer" }),
  ).toContainText(/LAYER\s*00/);
  await expect(
    page.getByRole("region", { name: "Simulation statistics" }),
  ).toContainText("1 cells");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await expect(
    page.getByRole("region", { name: "Time explorer" }),
  ).toContainText(/LAYER\s*01/);
  await slider.press("End");
  await page.getByRole("button", { name: "Play time" }).click();
  await expect(page.getByRole("button", { name: "Pause time" })).toBeVisible();
  await expect(slider).not.toHaveValue("1");
  await page.getByRole("button", { name: "Pause time" }).click();
  const paused = await slider.inputValue();
  await page.waitForTimeout(300); // Longer than two 130ms playback ticks.
  await expect(slider).toHaveValue(paused);
  await page.getByRole("button", { name: "Show all time layers" }).click();
  await expect(slider).toHaveValue("24");
});

test("a keyboard-accessible rule draft applies as a custom form and survives reload", async ({
  page,
}) => {
  await smallWorld(page);
  const original = await genotype(page).textContent();
  const edit = page.getByRole("button", { name: "Edit rule genome" });
  await edit.click();
  const dialog = page.getByRole("dialog", {
    name: /A rule for every encounter/i,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close rule editor" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Grow this rule" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close rule editor" }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "State 0, 0 neighbors: next state 0" }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "State 0, 1 neighbors: next state 0" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "State 0, 1 neighbors: next state 1" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "State 0, 1 neighbors: next state 2" }),
  ).toBeFocused();
  await expect(genotype(page)).toHaveText(original!);
  await dialog.getByRole("button", { name: "Grow this rule" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Custom form/ }),
  ).toBeVisible();
  const custom = await genotype(page).textContent();
  expect(custom).not.toBe(original);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Custom form/ }),
  ).toBeVisible();
  await expect(genotype(page)).toHaveText(custom!);
  await expect(page.getByRole("combobox", { name: "World size" })).toHaveValue(
    "25",
  );
  await edit.click();
  await dialog
    .getByRole("button", { name: "State 0, 1 neighbors: next state 2" })
    .click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(edit).toBeFocused();
  await expect(genotype(page)).toHaveText(custom!);
});

test("a real download and import round-trip the exact specimen after mutation", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
  await page.getByRole("button", { name: "Select Pagoda specimen" }).click();
  const original = await genotype(page).textContent();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save specimen" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^polyp-[A-F0-9]{8}\.json$/);
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const specimen = JSON.parse(await readFile(path, "utf8"));
  expect(specimen).toMatchObject({
    version: 1,
    name: "Pagoda",
    config: { size: 25, steps: 24, seed: "point", randomSeed: 1729 },
  });
  expect(specimen.genome).toHaveLength(45);
  expect(specimen.genome[0]).toBe(0);
  const mutation = page.getByRole("slider", { name: "Mutation rate" });
  await mutation.focus();
  await mutation.press("Home");
  await page.getByRole("button", { name: "Mutate this rule" }).click();
  await expect(genotype(page)).not.toHaveText(original!);
  await expect(
    page.getByRole("heading", { name: /Mutant form/ }),
  ).toBeVisible();
  await chooseFile(page, path);
  await expect(page.getByRole("status")).toContainText("Specimen imported.");
  await expect(genotype(page)).toHaveText(original!);
  await expect(page.getByRole("heading", { name: /Pagoda/ })).toBeVisible();
  await page.reload();
  await expect(genotype(page)).toHaveText(original!);
  await expect(page.getByRole("heading", { name: /Pagoda/ })).toBeVisible();
});

test("invalid and oversized files are rejected without replacing the current specimen", async ({
  page,
}) => {
  await smallWorld(page);
  const original = await genotype(page).textContent();
  await chooseFile(page, {
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":2}'),
  });
  await expect(page.getByRole("status")).toContainText("valid 45-gene");
  await expect(genotype(page)).toHaveText(original!);
  await chooseFile(page, {
    name: "oversize.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(100_001, 32),
  });
  await expect(page.getByRole("status")).toContainText("smaller than 100 KB");
  await expect(genotype(page)).toHaveText(original!);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("real worker evolution can run, pause, resume and reset when its environment changes", async ({
  page,
}) => {
  await smallWorld(page);
  await page.getByRole("button", { name: /02 Evolution/i }).click();
  await page
    .getByRole("combobox", { name: "Selection pressure" })
    .selectOption("longevity");
  await page.getByRole("button", { name: "Run evolution" }).click();
  await expect(
    page.getByRole("button", { name: "Pause evolution" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Play time" })).toBeDisabled();
  await expect(
    page.getByRole("slider", { name: "Visible time layer" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: /\d+ epochs of possibility/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Best fitness across evolutionary epochs" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause evolution" }).click();
  const epoch = await page
    .getByRole("heading", { name: /\d+ epochs of possibility/ })
    .textContent();
  await page.waitForTimeout(500); // A cancelled worker must not commit a late epoch.
  await expect(
    page.getByRole("heading", { name: /\d+ epochs of possibility/ }),
  ).toHaveText(epoch!);
  await expect(page.getByRole("button", { name: "Play time" })).toBeEnabled();
  await page.getByRole("button", { name: "Run evolution" }).click();
  await expect(
    page.getByRole("button", { name: "Pause evolution" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "World size" }).selectOption("33");
  await expect(
    page.getByRole("button", { name: "Run evolution" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Let the rules find their way." }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(
    page.getByRole("heading", { name: "Let the rules find their way." }),
  ).toBeVisible();
});

test("render tools, orbit drag, zoom and expanded-view escape are real pointer paths", async ({
  page,
}, testInfo) => {
  await smallWorld(page);
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
  await page.getByRole("button", { name: "Point rendering" }).click();
  await expect(
    page.getByRole("button", { name: "Point rendering" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "ember palette" }).click();
  await expect(
    page.getByRole("button", { name: "ember palette" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("switch", { name: "Dither and grain" }).click();
  await expect(
    page.getByRole("switch", { name: "Dither and grain" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Reset camera" }).click();
  const expand = page.getByRole("button", { name: "Expand view" });
  await expand.click();
  const expanded = page.getByRole("dialog", { name: "Expanded observatory" });
  await expect(expanded).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Exit expanded view" }),
  ).toBeVisible();
  await expanded.getByRole("button", { name: "Voxel rendering" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    expanded.getByRole("button", { name: "Show all time layers" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    expanded.getByRole("button", { name: "Voxel rendering" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Expand view" })).toBeVisible();
  await expect(expand).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("render-tools.png") });
});

test("the explanatory modal has a name, contains keyboard focus and restores its opener", async ({
  page,
}) => {
  const opener = page.getByRole("button", { name: "The idea behind it" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: /Life as a computation/i });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close model explanation" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("link", { name: "Read the original essay" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close model explanation" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("link", { name: "Read the original essay" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Close model explanation" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("the narrow viewport preserves readable controls and keyboard-accessible dialogs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await smallWorld(page);
  await page
    .getByRole("button", { name: "Select Archipelago specimen" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Archipelago/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit rule genome" }).click();
  const dialog = page.getByRole("dialog", {
    name: /A rule for every encounter/i,
  });
  await expect(
    dialog.getByRole("button", { name: "Grow this rule" }),
  ).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  // Read-only layout inspection; all app state changes above use actual input.
  expect(
    await page.locator("body").evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
});
