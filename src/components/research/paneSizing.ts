export type Pane = "registry" | "metrics" | "analysis";
export type PanePreferences = Partial<Record<Pane, number>>;
export const PANE_SIZES_KEY = "polyp.pane-sizes.v1";
export interface PaneVisibility {
  metrics: boolean;
  analysis: "expanded" | "collapsed" | "hidden";
}
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function readPanePreferences(raw: string | null): PanePreferences {
  try {
    const saved = JSON.parse(raw ?? "null");
    if (saved?.version !== 1) return {};
    return Object.fromEntries(
      ["registry", "metrics", "analysis"].flatMap((key) =>
        Number.isFinite(saved[key]) && saved[key] > 0
          ? [[key, saved[key]]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The original docked layout, with space reserved for a usable inspector. */
export function paneLayout(
  width: number,
  height: number,
  preferences: PanePreferences,
  visible: PaneVisibility,
) {
  const mobile = width <= 800;
  const body = Math.max(220, height - (width <= 570 ? 39 : 42));
  const registryMin = Math.min(176, Math.max(100, width - 40));
  const registryMax = Math.max(
    registryMin,
    Math.min(640, width - (mobile ? 40 : 360)),
  );
  const registryDefault = mobile
    ? 236
    : width <= 1150
      ? 205
      : width >= 1550
        ? 250
        : 232;
  const metricsMin = mobile ? 55 : 62;
  const analysisMin = 144;
  const reservedAnalysis =
    visible.analysis === "expanded"
      ? analysisMin
      : visible.analysis === "collapsed"
        ? 33
        : 0;
  const reservedMetrics = visible.metrics ? metricsMin : 0;
  const inspectorMin = Math.min(
    width <= 570 ? 240 : 230,
    Math.max(60, body - reservedAnalysis - reservedMetrics),
  );
  const metricSpace = Math.max(
    metricsMin,
    Math.min(200, body - reservedAnalysis - inspectorMin),
  );
  const metrics = clamp(
    preferences.metrics ?? metricsMin,
    metricsMin,
    metricSpace,
  );
  const analysisMax = Math.max(
    analysisMin,
    body - (visible.metrics ? metrics : 0) - inspectorMin,
  );
  const analysisDefault =
    width <= 570
      ? Math.max(220, height * 0.34)
      : mobile
        ? Math.max(200, height * 0.35)
        : width >= 1550
          ? Math.min(480, height * 0.38)
          : clamp(height * 0.38, 270, 390);
  const analysis = clamp(
    preferences.analysis ?? analysisDefault,
    analysisMin,
    analysisMax,
  );
  return {
    inspectorMin,
    registry: {
      value: clamp(
        preferences.registry ?? registryDefault,
        registryMin,
        registryMax,
      ),
      min: registryMin,
      max: registryMax,
    },
    metrics: {
      value: metrics,
      min: metricsMin,
      max: Math.max(
        metricsMin,
        Math.min(
          200,
          body -
            inspectorMin -
            (visible.analysis === "expanded" ? analysis : reservedAnalysis),
        ),
      ),
    },
    analysis: { value: analysis, min: analysisMin, max: analysisMax },
  };
}
