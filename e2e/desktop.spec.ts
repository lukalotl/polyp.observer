import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(
    box.x + Math.min(75, box.width / 2),
    box.y + box.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + Math.min(75, box.width / 2) + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 },
  );
  await page.mouse.up();
}

test("all terminal panels move, resize, restore and preserve their positions without changing research", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Live VM connection", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-window]")).toHaveCount(6);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      !request.url().endsWith("/preview")
    )
      mutations.push(request.url());
  });
  const clock = page.locator('[data-window="clock"]');
  const before = (await clock.boundingBox())!;
  await drag(
    page,
    page.getByRole("button", { name: "Move clock window", exact: true }),
    -100,
    50,
  );
  await expect
    .poll(async () => (await clock.boundingBox())!.x)
    .toBeCloseTo(before.x - 100, 0);
  await page
    .getByRole("button", { name: "Move clock window", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect
    .poll(async () => (await clock.boundingBox())!.x)
    .toBeCloseTo(before.x - 90, 0);
  await expect
    .poll(async () => (await clock.boundingBox())!.y)
    .toBeCloseTo(before.y + 51, 0);
  await drag(
    page,
    page.getByRole("button", { name: "Resize clock window", exact: true }),
    40,
    30,
  );
  const changed = (await clock.boundingBox())!;
  expect(changed.width).toBeCloseTo(before.width + 40, 0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(
          localStorage.getItem("polyp.desktop.layout.v1") || "null",
        );
        return saved?.frames.clock.width;
      }),
    )
    .toBeCloseTo(changed.width, 0);
  await page.reload();
  await expect
    .poll(async () => (await clock.boundingBox())!.x)
    .toBeCloseTo(changed.x, 0);
  await expect
    .poll(async () => (await clock.boundingBox())!.width)
    .toBeCloseTo(changed.width, 0);
  await page
    .getByRole("button", { name: "Maximize clock window", exact: true })
    .click();
  await expect
    .poll(async () => (await clock.boundingBox())!.width)
    .toBeGreaterThan(1400);
  await page
    .getByRole("button", { name: "Restore clock window", exact: true })
    .click();
  for (const title of [
    "registry",
    "metrics",
    "spacetime",
    "population",
    "ascii",
  ]) {
    const handle = page.getByRole("button", {
      name: "Move " + title + " window",
      exact: true,
    });
    // Keyboard focus raises a partially overlapped window just as tab navigation does.
    await handle.focus();
    const start = (await handle.boundingBox())!;
    await drag(page, handle, 8, 8);
    await expect
      .poll(async () => (await handle.boundingBox())!.x)
      .toBeCloseTo(start.x + 8, 0);
    await expect
      .poll(async () => (await handle.boundingBox())!.y)
      .toBeCloseTo(start.y + 8, 0);
  }
  await page
    .getByRole("button", { name: "Pause ASCII animation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play ASCII animation", exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
  await page
    .getByRole("button", { name: "Maximize clock window", exact: true })
    .focus();
  await page
    .getByRole("button", { name: "Maximize clock window", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset window layout", exact: true })
    .click();
  await expect
    .poll(async () => (await clock.boundingBox())!.x)
    .toBeCloseTo(before.x, 0);
  await expect
    .poll(async () => (await clock.boundingBox())!.width)
    .toBeCloseTo(before.width, 0);
});

test("run configuration can be dragged and remains a working accessible dialog", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "New run", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "New run", exact: true });
  const before = (await dialog.boundingBox())!;
  await drag(
    page,
    page.getByRole("button", {
      name: "Move run configuration window",
      exact: true,
    }),
    75,
    0,
  );
  await expect
    .poll(async () => (await dialog.boundingBox())!.x)
    .toBeCloseTo(before.x + 75, 0);
  await page
    .getByRole("textbox", { name: "Run name", exact: true })
    .fill("Movable configuration");
  await expect(
    page.getByRole("textbox", { name: "Run name", exact: true }),
  ).toHaveValue("Movable configuration");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("phone windows stay reachable without horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("[data-window]")).toHaveCount(6);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const handle = page.getByRole("button", {
    name: "Move ascii window",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  await expect(handle).toBeVisible();
  await drag(page, handle, -500, 0);
  expect(
    (await page.locator('[data-window="ascii"]').boundingBox())!.x,
  ).toBeGreaterThanOrEqual(6);
  await page
    .getByRole("button", { name: "Reset window layout", exact: true })
    .click();
});
