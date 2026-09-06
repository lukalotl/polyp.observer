import { describe, expect, it } from "vitest";
import {
  paneLayout,
  readPanePreferences,
  type PaneVisibility,
} from "./paneSizing";

const visible: PaneVisibility = { metrics: true, analysis: "expanded" };
describe("docked pane sizing", () => {
  it("preserves the original desktop proportions without saved preferences", () => {
    const result = paneLayout(1440, 1000, {}, visible);
    expect(result.registry.value).toBe(232);
    expect(result.metrics.value).toBe(62);
    expect(result.analysis.value).toBe(380);
    expect(result.inspectorMin).toBe(230);
  });
  it("keeps an inspector visible when oversized saved panes meet a smaller viewport", () => {
    for (const [width, height] of [
      [1440, 1000],
      [1080, 675],
      [390, 844],
      [375, 480],
    ]) {
      const result = paneLayout(
        width,
        height,
        { registry: 9999, metrics: 9999, analysis: 9999 },
        visible,
      );
      expect(result.registry.value).toBeLessThanOrEqual(
        width - (width <= 800 ? 40 : 360),
      );
      expect(
        result.metrics.value + result.analysis.value + result.inspectorMin,
      ).toBeLessThanOrEqual(height - (width <= 570 ? 39 : 42));
      expect(result.inspectorMin).toBeGreaterThanOrEqual(60);
    }
  });
  it("accounts for a collapsed analysis header and releases hidden pane space", () => {
    const expanded = paneLayout(1080, 675, {}, visible);
    const collapsed = paneLayout(
      1080,
      675,
      {},
      { metrics: true, analysis: "collapsed" },
    );
    const hiddenMetrics = paneLayout(
      1080,
      675,
      {},
      { metrics: false, analysis: "expanded" },
    );
    expect(collapsed.metrics.max).toBeGreaterThan(expanded.metrics.max);
    expect(hiddenMetrics.analysis.max).toBe(expanded.analysis.max + 62);
  });
  it("rejects corrupt preferences while retaining independently valid pane sizes", () => {
    expect(
      readPanePreferences(
        '{"version":1,"registry":300,"metrics":-1,"analysis":"NaN"}',
      ),
    ).toEqual({ registry: 300 });
    for (const value of [
      null,
      "{broken",
      "null",
      '{"version":2,"registry":300}',
    ])
      expect(readPanePreferences(value)).toEqual({});
    expect(
      readPanePreferences(
        '{"version":1,"registry":300,"metrics":100,"analysis":310}',
      ),
    ).toEqual({ registry: 300, metrics: 100, analysis: 310 });
  });
});
