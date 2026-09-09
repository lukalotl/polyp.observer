import { test, expect } from "@playwright/test";
import { DEFAULT_RUN_CONFIG } from "../src/research/config";
import type { RunDetail } from "../src/research/types";

test("saved runs with unused retention do not prevent creating and starting research", async ({
  page,
  request,
}) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "Bulk registry fixtures belong only in the isolated test service.",
  );
  const ids: string[] = [];
  const config = {
    ...DEFAULT_RUN_CONFIG,
    name: `Memory regression ${Date.now()}`,
    size: 9,
    steps: 8,
    populationSize: 256,
    retainedSnapshots: 100,
    evaluationWorkers: 1,
    maxGenerations: 1,
  };
  try {
    // These stopped configurations formerly reserved >512 MiB despite having
    // no populations yet. Seed through the real API, then exercise the user path.
    for (let i = 0; i < 11; i++) {
      const response = await request.post("/api/runs", {
        data: { config: { ...config, name: `${config.name} stored ${i}` } },
      });
      expect(response.status()).toBe(201);
      ids.push(((await response.json()) as RunDetail).summary.id);
    }
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Live VM connection" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New run", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New run", exact: true });
    await dialog
      .getByRole("button", { name: "Edit configuration JSON" })
      .click();
    await dialog
      .getByRole("textbox", { name: "Configuration JSON" })
      .fill(JSON.stringify(config));
    await dialog.getByRole("button", { name: "Use parameter fields" }).click();
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runs") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Create & start", exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    const run = (await response.json()) as RunDetail;
    ids.push(run.summary.id);
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: `Select run ${config.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            (await (
              await request.get(`/api/runs/${run.summary.id}`)
            ).json()) as RunDetail
          ).summary.status,
      )
      .toBe("completed");
    const health = await (await request.get("/api/health")).json();
    expect(health.memory.reservedBytes).toBeLessThan(health.memory.limitBytes);
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: `Select run ${config.name}`,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    for (const id of ids) {
      const response = await request.post(`/api/runs/${id}/actions`, {
        data: { action: "archive" },
      });
      expect(response.ok()).toBe(true);
    }
  }
});
