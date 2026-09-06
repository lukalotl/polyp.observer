import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Focus,
  GitBranch,
  List,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  SkipForward,
  Upload,
  X,
} from "lucide-react";
import Volume from "./components/Volume";
import RunDialog from "./components/research/RunDialog";
import PopulationView from "./components/research/PopulationView";
import GeneticsView from "./components/research/GeneticsView";
import HistoryView from "./components/research/HistoryView";
import ComparisonView from "./components/research/ComparisonView";
import { useResearch } from "./useResearch";
import { DEFAULT_RUN_CONFIG } from "./research/config";
import { download, request } from "./research/api";
import { decodePreview } from "./research/preview";
import { duration, fitnessNumber, number, time } from "./research/format";
import { parseExperiment } from "./experiment";
import type {
  GenerationSnapshot,
  Individual,
  PreviewFrame,
  RunCheckpoint,
  RunConfig,
  RunStatus,
} from "./research/types";

const ACTIVE: RunStatus[] = ["running", "queued", "starting", "pausing"];
type Panel = "population" | "genetics" | "history" | "compare" | "parameters";
const panelNames: Record<Panel, string> = {
  population: "Population",
  genetics: "Genetics",
  history: "History",
  compare: "Compare",
  parameters: "Parameters",
};

export default function App() {
  const lab = useResearch();
  const [showRuns, setShowRuns] = useState(() => window.innerWidth > 800);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [showMetrics, setShowMetrics] = useState(true);
  const [focus, setFocus] = useState(false);
  const [panel, setPanel] = useState<Panel>("population");
  const [newConfig, setNewConfig] = useState<RunConfig | null>(null);
  const [configurationTitle, setConfigurationTitle] = useState("New run");
  const [showArchived, setShowArchived] = useState(false);
  const [historical, setHistorical] = useState<GenerationSnapshot | null>(null);
  const [requestedGeneration, setRequestedGeneration] = useState<number | null>(
    null,
  );
  const [historyBusy, setHistoryBusy] = useState(false);
  const [selected, setSelected] = useState<{
    individual: Individual;
    generation: number;
  } | null>(null);
  const [source, setSource] = useState<"best" | "generation" | "selected">(
    "best",
  );
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [fixtureSeed, setFixtureSeed] = useState<number | null>(null);
  const [visibleLayers, setVisibleLayers] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [displayMode, setDisplayMode] = useState<"volume" | "slice">("volume");
  const [view, setView] = useState<"iso" | "top" | "front">("iso");
  const [material, setMaterial] = useState<"voxels" | "points">("voxels");
  const [palette, setPalette] = useState<"mineral" | "ember" | "ink">(
    "mineral",
  );
  const [grain, setGrain] = useState(true);
  const [annotations, setAnnotations] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [viewOptions, setViewOptions] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [localError, setLocalError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const detail = lab.detail;
  const run = detail?.summary;
  const workingSnapshot = historical ?? detail?.snapshot ?? null;
  const generationBest = useMemo(
    () =>
      workingSnapshot?.population.reduce<Individual | null>(
        (best, individual) =>
          !best || individual.fitness > best.fitness ? individual : best,
        null,
      ) ?? null,
    [workingSnapshot],
  );
  const individual =
    source === "selected"
      ? (selected?.individual ?? null)
      : source === "generation"
        ? generationBest
        : (detail?.snapshot?.champion ?? null);
  const genome = individual?.genome ?? detail?.config.seedGenome ?? null;
  const genomeKey = genome?.join("") ?? "";
  const previewSeed = fixtureSeed ?? detail?.config.trainingSeeds[0] ?? 1729;
  const decoded = useMemo(() => (frame ? decodePreview(frame) : null), [frame]);
  const layer = Math.max(
    0,
    Math.min((decoded?.layers.length ?? 1) - 1, visibleLayers - 1),
  );
  const renderSimulation = useMemo(
    () =>
      !decoded
        ? null
        : displayMode === "slice"
          ? {
              size: decoded.size,
              layers: [decoded.layers[layer]],
              layerTimes: [decoded.layerTimes[layer]],
            }
          : decoded,
    [decoded, displayMode, layer],
  );
  const actualTime = decoded?.layerTimes[layer] ?? 0;
  const isActive = run ? ACTIVE.includes(run.status) : false;
  const actionError = localError || lab.error;

  useEffect(() => {
    setHistorical(null);
    setRequestedGeneration(null);
    setSelected(null);
    setSource("best");
    setFixtureSeed(null);
    setFrame(null);
    setPreviewError("");
    setPlaying(false);
  }, [lab.selectedId]);

  useEffect(() => {
    if (!lab.selectedId || !genome || !detail) return;
    const controller = new AbortController();
    setPreviewBusy(true);
    setPreviewError("");
    setPlaying(false);
    void request<PreviewFrame>(
      `/api/runs/${encodeURIComponent(lab.selectedId)}/preview`,
      {
        method: "POST",
        body: JSON.stringify({ genome, seed: previewSeed }),
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        decodePreview(value);
        setFrame(value);
        setVisibleLayers(value.layerTimes.length);
        setResetKey((key) => key + 1);
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setPreviewError(
            caught instanceof Error ? caught.message : "Preview failed.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewBusy(false);
      });
    return () => controller.abort();
    // Preview follows the genotype, not every generation or metric update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lab.selectedId,
    genomeKey,
    previewSeed,
    detail?.config.size,
    detail?.config.steps,
  ]);

  useEffect(() => {
    if (!lab.selectedId || requestedGeneration === null) {
      setHistorical(null);
      setHistoryBusy(false);
      return;
    }
    const controller = new AbortController();
    setHistoryBusy(true);
    void request<GenerationSnapshot>(
      `/api/runs/${encodeURIComponent(lab.selectedId)}/generations/${requestedGeneration}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setHistorical(value);
          setSource("generation");
          setSelected(null);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setLocalError(
            caught instanceof Error
              ? caught.message
              : "Population snapshot unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryBusy(false);
      });
    return () => controller.abort();
  }, [lab.selectedId, requestedGeneration]);

  useEffect(() => {
    if (!playing || !decoded) return;
    const timer = setInterval(
      () =>
        setVisibleLayers((value) => Math.min(decoded.layers.length, value + 1)),
      100,
    );
    return () => clearInterval(timer);
  }, [playing, decoded]);
  useEffect(() => {
    if (playing && decoded && visibleLayers >= decoded.layers.length)
      setPlaying(false);
  }, [playing, decoded, visibleLayers]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A table/chart owns its handled keys; inspecting data must never start or
      // pause an indefinite VM run as an accidental global-shortcut side effect.
      if (event.defaultPrevented || document.querySelector("dialog[open]"))
        return;
      if (event.key === "Escape") {
        setFocus(false);
        setViewOptions(false);
        return;
      }
      if (
        (event.target as HTMLElement).matches(
          "input, select, button, textarea, summary",
        )
      )
        return;
      if (
        event.code === "Space" &&
        run &&
        !lab.busy &&
        !["failed", "completed", "archived", "pausing"].includes(run.status)
      ) {
        event.preventDefault();
        void lab.action(run.id, isActive ? "pause" : "start").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, lab, isActive]);

  function openNew(base?: RunConfig, title = "New run") {
    const config = structuredClone(base ?? DEFAULT_RUN_CONFIG);
    if (!base)
      config.evaluationWorkers = Math.max(
        1,
        Math.min(
          config.evaluationWorkers,
          lab.capacity.maxEvaluationWorkers || 1,
        ),
      );
    setConfigurationTitle(title);
    setNewConfig(config);
  }
  function variant() {
    if (!detail) return;
    openNew(
      {
        ...structuredClone(detail.config),
        name: `${detail.config.name.slice(0, 60)} · variant`,
        seedGenome: [
          ...(detail.snapshot?.champion.genome ?? detail.config.seedGenome),
        ],
        initialization: "mutants",
      },
      "New variant from champion",
    );
  }
  function selectIndividual(value: Individual) {
    setSelected({
      individual: value,
      generation: workingSnapshot?.generation ?? value.birthGeneration,
    });
    setSource("selected");
    setPlaying(false);
  }
  function doAction(
    action: "start" | "pause" | "step" | "checkpoint" | "archive",
  ) {
    if (run) void lab.action(run.id, action).catch(() => {});
  }
  async function exportCheckpoint() {
    if (!run) return;
    try {
      await lab.action(run.id, "checkpoint");
      download(`/api/runs/${encodeURIComponent(run.id)}/checkpoint`);
    } catch {
      /* Hook exposes the error. */
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024)
        throw new Error("Checkpoint exceeds 16 MiB.");
      const text = await file.text();
      const value = JSON.parse(text);
      if (value?.format === "polyp-research-checkpoint")
        await lab.importCheckpoint(value as RunCheckpoint);
      else {
        const founder = parseExperiment(text);
        openNew(
          {
            ...structuredClone(DEFAULT_RUN_CONFIG),
            name: founder.name || "Imported founder",
            seedGenome: founder.genome,
            size: founder.config.size,
            steps: founder.config.steps,
            seed: founder.config.seed,
            trainingSeeds: [founder.config.randomSeed],
          },
          "New run from imported founder",
        );
      }
      setLocalError("");
    } catch (caught) {
      setLocalError(
        caught instanceof Error ? caught.message : "Import failed.",
      );
    }
    if (upload.current) upload.current.value = "";
  }

  return (
    <div ref={root} className={`research-app ${focus ? "focus-mode" : ""}`}>
      <header className="research-toolbar" aria-label="Research controls">
        <button
          aria-label="Toggle run registry"
          aria-pressed={showRuns && !focus}
          onClick={() => {
            setFocus(false);
            setShowRuns((value) => !value);
          }}
          title="Runs"
        >
          <List size={16} />
        </button>
        <button
          className="primary-action"
          disabled={lab.loading || !lab.capacity.maxEvaluationWorkers}
          onClick={() => openNew()}
        >
          <Plus size={14} />
          New run
        </button>
        <span className="toolbar-divider" />
        <span className="toolbar-run-name" title={run?.name}>
          {run?.name ?? "No run selected"}
        </span>
        {run && (
          <span className={`run-status ${run.status}`}>{run.status}</span>
        )}
        <span className="toolbar-space" />
        <button
          disabled={
            !run ||
            lab.busy ||
            ["failed", "completed", "archived", "pausing"].includes(run.status)
          }
          className={isActive ? "running-action" : ""}
          aria-label={isActive ? "Pause run" : "Start run"}
          title="Start / pause · Space"
          onClick={() => doAction(isActive ? "pause" : "start")}
        >
          {isActive ? <Pause size={14} /> : <Play size={14} />}
          <span className="toolbar-button-label">
            {isActive ? "Pause" : "Start"}
          </span>
        </button>
        <button
          disabled={!run || run.status !== "paused" || lab.busy}
          aria-label="Step one generation"
          title="Advance one full GA generation"
          onClick={() => doAction("step")}
        >
          <SkipForward size={15} />
          <span className="toolbar-button-label">Step</span>
        </button>
        <button
          disabled={!run || lab.busy || run.status === "archived"}
          aria-label="Save checkpoint"
          title="Write a durable checkpoint"
          onClick={() => doAction("checkpoint")}
        >
          <Copy size={14} />
          <span className="toolbar-button-label">Checkpoint</span>
        </button>
        <button
          disabled={!run || lab.busy || !detail?.snapshot}
          aria-label="Fork run"
          title="Fork the complete population and RNG state, paused"
          onClick={() => {
            if (run) void lab.fork(run.id).catch(() => {});
          }}
        >
          <GitBranch size={15} />
          <span className="toolbar-button-label">Fork</span>
        </button>
        <span className="toolbar-divider" />
        <button
          className={`connection-badge ${lab.connection}`}
          aria-label={
            lab.connection === "connected"
              ? "Live VM connection"
              : "Reconnect live updates"
          }
          title={lab.connectionError || "Runs continue without this browser"}
          onClick={lab.reconnect}
        >
          <i />
          {lab.connection === "connected" ? "Live" : "Reconnect"}
        </button>
      </header>

      <div className="research-body">
        {showRuns && !focus && (
          <aside className="run-registry" aria-label="Run registry">
            <div className="registry-heading">
              <span>Runs</span>
              <div className="button-row">
                <button
                  aria-label="Refresh runs"
                  title="Refresh runs"
                  onClick={() => void lab.refresh()}
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  aria-label="Import checkpoint"
                  title="Import checkpoint or founder"
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={14} />
                </button>
              </div>
            </div>
            <div className="capacity-line">
              <span>
                {lab.capacity.maxEvaluationWorkers
                  ? `${lab.capacity.allocatedWorkers} / ${lab.capacity.maxEvaluationWorkers} evaluators`
                  : "Connecting…"}
              </span>
              <span>
                {
                  lab.runs.filter((value) => ACTIVE.includes(value.status))
                    .length
                }{" "}
                active / queued
              </span>
            </div>
            <div className="run-list">
              {lab.runs
                .filter((value) => showArchived || value.status !== "archived")
                .map((value) => (
                  <button
                    key={value.id}
                    className={`run-row ${lab.selectedId === value.id ? "selected" : ""}`}
                    aria-label={`Select run ${value.name}`}
                    aria-pressed={lab.selectedId === value.id}
                    onClick={() => lab.select(value.id)}
                  >
                    <div className="run-row-title">
                      <i className={`status-dot ${value.status}`} />
                      <strong>{value.name}</strong>
                    </div>
                    <div className="run-row-meta">
                      <span>
                        {value.generation >= 0
                          ? `g ${number(value.generation)}`
                          : "not initialized"}
                      </span>
                      <span>{fitnessNumber(value.bestFitness)}</span>
                    </div>
                    <div className="run-row-sub">
                      <span>
                        {value.status}
                        {value.queuePosition !== null
                          ? ` #${value.queuePosition}`
                          : ""}
                      </span>
                      <span>{duration(value.elapsedMs)}</span>
                    </div>
                  </button>
                ))}
              {!lab.loading && !lab.runs.length && (
                <div className="empty-registry">
                  No runs.
                  <button onClick={() => openNew()}>Create experiment</button>
                </div>
              )}
            </div>
            <div className="registry-footer">
              <label>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                Archived
              </label>
              <button
                disabled={
                  !run || isActive || lab.busy || run.status === "archived"
                }
                onClick={() => doAction("archive")}
                title="Archive paused run"
                aria-label="Archive run"
              >
                <Archive size={13} />
              </button>
            </div>
          </aside>
        )}

        <main className="research-workspace">
          {(actionError || lab.connectionError) && (
            <div
              className={`research-error ${actionError ? "" : "connection-warning"}`}
              role="alert"
            >
              <span>{actionError || lab.connectionError}</span>
              {actionError && (
                <button
                  aria-label="Dismiss error"
                  onClick={() => {
                    setLocalError("");
                    lab.clearError();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          {!detail ? (
            <div className="no-run-view">
              <span>
                {lab.loading
                  ? "Loading runs…"
                  : lab.selectedId
                    ? "Loading experiment…"
                    : "Select or create an experiment."}
              </span>
              {!lab.selectedId && (
                <button
                  className="primary-action"
                  disabled={!lab.capacity.maxEvaluationWorkers}
                  onClick={() => openNew()}
                >
                  <Plus size={14} />
                  New run
                </button>
              )}
            </div>
          ) : (
            <>
              {!focus && showMetrics && (
                <section className="run-metrics" aria-label="Run metrics">
                  <div>
                    <span>Generation</span>
                    <strong>
                      {run!.generation < 0 ? "—" : number(run!.generation)}
                      <small>
                        {detail.config.maxGenerations
                          ? ` / ${number(detail.config.maxGenerations)}`
                          : " / ∞"}
                      </small>
                    </strong>
                  </div>
                  <div>
                    <span>Best ever</span>
                    <strong title={String(run!.bestFitness ?? "Not evaluated")}>
                      {fitnessNumber(run!.bestFitness)}
                    </strong>
                  </div>
                  <div>
                    <span>Population mean</span>
                    <strong title={String(run!.meanFitness ?? "Not evaluated")}>
                      {fitnessNumber(run!.meanFitness)}
                    </strong>
                  </div>
                  <div>
                    <span>Held-out</span>
                    <strong
                      title={String(run!.validationFitness ?? "Not evaluated")}
                    >
                      {fitnessNumber(run!.validationFitness)}
                    </strong>
                  </div>
                  <div>
                    <span>Fixture evals / s</span>
                    <strong>{number(run!.evalsPerSecond, 1)}</strong>
                  </div>
                  <div>
                    <span>Evaluations</span>
                    <strong>{number(run!.evaluations)}</strong>
                  </div>
                  <div>
                    <span>Checkpoint</span>
                    <strong className="metric-time">
                      {time(run!.checkpointAt)}
                    </strong>
                  </div>
                  <button
                    aria-label="Hide run metrics"
                    title="Hide metrics"
                    onClick={() => setShowMetrics(false)}
                  >
                    <X size={13} />
                  </button>
                </section>
              )}
              <section
                className="champion-pane"
                aria-label="Champion inspector"
              >
                <div className="inspector-toolbar">
                  <select
                    aria-label="Inspected candidate"
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value as typeof source);
                      setPlaying(false);
                    }}
                  >
                    <option value="best">Best ever</option>
                    <option value="generation">Generation best</option>
                    <option value="selected" disabled={!selected}>
                      Selected individual
                    </option>
                  </select>
                  <span className="candidate-identity" title={individual?.id}>
                    {individual
                      ? `${individual.id} · ${fitnessNumber(individual.fitness)}`
                      : "Founder · not evaluated"}
                  </span>
                  <span className="toolbar-space" />
                  {frame && frame.stride > 1 && (
                    <span
                      className="sample-badge"
                      title="Preview is sampled. Fitness uses every CA timestep."
                    >
                      preview ×{frame.stride}
                    </span>
                  )}
                  <button
                    aria-label="Reset specimen camera"
                    title="Fit specimen"
                    onClick={() => setResetKey((key) => key + 1)}
                  >
                    <Focus size={15} />
                  </button>
                  <button
                    aria-label="Inspector view options"
                    title="View options"
                    aria-expanded={viewOptions}
                    onClick={() => setViewOptions((value) => !value)}
                  >
                    <Settings2 size={15} />
                  </button>
                  <button
                    aria-label={focus ? "Exit focus view" : "Focus champion"}
                    title="Focus champion"
                    onClick={() => setFocus((value) => !value)}
                  >
                    {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                </div>
                <div className="champion-canvas">
                  {renderSimulation && (
                    <Volume
                      simulation={renderSimulation}
                      visibleLayers={
                        displayMode === "slice" ? 1 : visibleLayers
                      }
                      palette={palette}
                      mode={material}
                      grain={grain}
                      autoRotate={autoRotate}
                      annotations={annotations}
                      fitMode="specimen"
                      view={displayMode === "slice" ? "top" : view}
                      resetKey={resetKey}
                      onLayerSelect={(index) => {
                        if (displayMode === "volume") {
                          setPlaying(false);
                          setVisibleLayers(index + 1);
                        }
                      }}
                    />
                  )}
                  {(!frame || previewBusy) && (
                    <div
                      className={`preview-loading ${frame ? "subtle" : ""}`}
                      role="status"
                    >
                      {previewBusy ? "Evaluating preview…" : "No preview"}
                    </div>
                  )}
                  {previewError && (
                    <div className="preview-error" role="alert">
                      {previewError}
                    </div>
                  )}
                  {viewOptions && (
                    <div className="view-options" aria-label="View options">
                      <label>
                        <span>Mode</span>
                        <select
                          aria-label="Preview display"
                          value={displayMode}
                          onChange={(event) =>
                            setDisplayMode(
                              event.target.value as typeof displayMode,
                            )
                          }
                        >
                          <option value="volume">Spacetime volume</option>
                          <option value="slice">2D slice</option>
                        </select>
                      </label>
                      <label>
                        <span>Camera</span>
                        <select
                          aria-label="Camera view"
                          value={view}
                          onChange={(event) => {
                            setView(event.target.value as typeof view);
                            setResetKey((key) => key + 1);
                          }}
                        >
                          <option value="iso">Isometric</option>
                          <option value="top">Top</option>
                          <option value="front">Front</option>
                        </select>
                      </label>
                      <label>
                        <span>Material</span>
                        <select
                          aria-label="Render material"
                          value={material}
                          onChange={(event) =>
                            setMaterial(event.target.value as typeof material)
                          }
                        >
                          <option value="voxels">Voxels</option>
                          <option value="points">Points</option>
                        </select>
                      </label>
                      <label>
                        <span>Palette</span>
                        <select
                          aria-label="Palette"
                          value={palette}
                          onChange={(event) =>
                            setPalette(event.target.value as typeof palette)
                          }
                        >
                          <option value="mineral">Mineral</option>
                          <option value="ember">Ember</option>
                          <option value="ink">Ink</option>
                        </select>
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={grain}
                          onChange={(event) => setGrain(event.target.checked)}
                        />
                        Dither
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={autoRotate}
                          onChange={(event) =>
                            setAutoRotate(event.target.checked)
                          }
                        />
                        Orbit
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={annotations}
                          onChange={(event) =>
                            setAnnotations(event.target.checked)
                          }
                        />
                        Reference grid
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={showMetrics}
                          onChange={(event) =>
                            setShowMetrics(event.target.checked)
                          }
                        />
                        Run metrics
                      </label>
                    </div>
                  )}
                </div>
                <div className="ca-timeline">
                  <button
                    aria-label={
                      playing ? "Pause CA playback" : "Play CA history"
                    }
                    disabled={!decoded}
                    onClick={() => {
                      if (
                        !playing &&
                        decoded &&
                        visibleLayers >= decoded.layers.length
                      )
                        setVisibleLayers(1);
                      setPlaying((value) => !value);
                    }}
                  >
                    {playing ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                  <span>CA t</span>
                  <input
                    type="range"
                    aria-label="CA timestep"
                    min="1"
                    max={decoded?.layers.length ?? 1}
                    value={decoded ? visibleLayers : 1}
                    disabled={!decoded}
                    onChange={(event) => {
                      setPlaying(false);
                      setVisibleLayers(Number(event.target.value));
                    }}
                  />
                  <output>
                    {actualTime} / {Math.max(0, (frame?.totalSteps ?? 1) - 1)}
                  </output>
                  <select
                    aria-label="Preview fixture"
                    value={String(previewSeed)}
                    onChange={(event) =>
                      setFixtureSeed(Number(event.target.value))
                    }
                  >
                    {detail.config.trainingSeeds.map((seed) => (
                      <option key={`t${seed}`} value={seed}>
                        Train {seed}
                      </option>
                    ))}
                    {detail.config.validationSeeds.map((seed) => (
                      <option key={`v${seed}`} value={seed}>
                        Held-out {seed}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              {!focus && (
                <section
                  className={`analysis-pane ${showAnalysis ? "" : "collapsed"}`}
                  aria-label="Genetic analysis"
                >
                  <header className="analysis-tabs">
                    <div role="tablist" aria-label="Analysis views">
                      {(Object.keys(panelNames) as Panel[]).map((key) => (
                        <button
                          key={key}
                          role="tab"
                          aria-selected={panel === key && showAnalysis}
                          onClick={() => {
                            setPanel(key);
                            setShowAnalysis(true);
                          }}
                        >
                          {panelNames[key]}
                        </button>
                      ))}
                    </div>
                    <span className="toolbar-space" />
                    {workingSnapshot && (
                      <button
                        className="analysis-generation"
                        aria-label={
                          historical
                            ? "Return to live population"
                            : "Freeze population view"
                        }
                        title={
                          historical
                            ? "Follow the live population"
                            : "Freeze this population without pausing training"
                        }
                        onClick={() => {
                          if (historical) {
                            setRequestedGeneration(null);
                            setHistorical(null);
                            setSource("best");
                          } else if (detail.snapshot) {
                            setHistorical(detail.snapshot);
                            setSource("generation");
                            setSelected(null);
                          }
                        }}
                      >
                        {historical
                          ? requestedGeneration === null
                            ? "pinned"
                            : "archive"
                          : "live"}{" "}
                        g {number(workingSnapshot.generation)}
                      </button>
                    )}
                    <button
                      aria-label={
                        showAnalysis
                          ? "Hide analysis panels"
                          : "Show analysis panels"
                      }
                      onClick={() => setShowAnalysis((value) => !value)}
                    >
                      {showAnalysis ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                    </button>
                  </header>
                  {showAnalysis && (
                    <div
                      className="analysis-content"
                      role="tabpanel"
                      aria-label={panelNames[panel]}
                    >
                      {historyBusy && (
                        <span className="analysis-busy" role="status">
                          Loading population…
                        </span>
                      )}
                      {panel === "population" && (
                        <PopulationView
                          snapshot={workingSnapshot}
                          selectedId={
                            source === "selected"
                              ? (selected?.individual.id ?? null)
                              : (individual?.id ?? null)
                          }
                          onSelect={selectIndividual}
                        />
                      )}
                      {panel === "genetics" && (
                        <GeneticsView
                          individual={individual}
                          snapshot={workingSnapshot}
                        />
                      )}
                      {panel === "history" && (
                        <HistoryView
                          history={detail.history}
                          snapshots={detail.snapshots}
                          selectedGeneration={requestedGeneration}
                          onSelectGeneration={(generation) => {
                            setRequestedGeneration(generation);
                            if (generation === null) {
                              setHistorical(null);
                              setSource("best");
                            }
                          }}
                        />
                      )}
                      {panel === "compare" && (
                        <ComparisonView
                          runs={lab.runs}
                          selectedRunId={detail.summary.id}
                        />
                      )}
                      {panel === "parameters" && (
                        <div className="parameters-view">
                          <div className="parameter-actions">
                            <button onClick={variant}>
                              <GitBranch size={13} />
                              New variant from champion
                            </button>
                            <button
                              onClick={() => void exportCheckpoint()}
                              disabled={lab.busy}
                            >
                              <Download size={13} />
                              Export checkpoint
                            </button>
                            <button
                              onClick={() =>
                                download(
                                  `/api/runs/${detail.summary.id}/metrics.csv`,
                                )
                              }
                            >
                              <Download size={13} />
                              Metrics CSV
                            </button>
                            <span>
                              Immutable configuration · generation-boundary
                              checkpoints
                            </span>
                          </div>
                          <div className="parameters-columns">
                            <dl>
                              <div>
                                <dt>Run ID</dt>
                                <dd>{detail.summary.id}</dd>
                              </div>
                              <div>
                                <dt>Engine model</dt>
                                <dd>{lab.modelVersion ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Threads allocated</dt>
                                <dd>{detail.summary.workerCount}</dd>
                              </div>
                              <div>
                                <dt>Training time</dt>
                                <dd>{duration(detail.summary.elapsedMs)}</dd>
                              </div>
                              <div>
                                <dt>Generation time</dt>
                                <dd>
                                  {number(detail.summary.generationMs, 1)} ms
                                </dd>
                              </div>
                              <div>
                                <dt>Cache hits</dt>
                                <dd>{number(detail.summary.cacheHits)}</dd>
                              </div>
                              <div>
                                <dt>Allelic entropy</dt>
                                <dd>{detail.summary.diversity.toFixed(4)}</dd>
                              </div>
                              <div>
                                <dt>Unique rules</dt>
                                <dd>{detail.summary.uniqueGenomes}</dd>
                              </div>
                              <div>
                                <dt>Retained history</dt>
                                <dd>
                                  {detail.history.length} points /{" "}
                                  {detail.snapshots.length} populations
                                </dd>
                              </div>
                              {detail.summary.parentRunId && (
                                <div>
                                  <dt>Parent run</dt>
                                  <dd>{detail.summary.parentRunId}</dd>
                                </div>
                              )}
                              {detail.summary.stopReason && (
                                <div>
                                  <dt>Stop reason</dt>
                                  <dd>{detail.summary.stopReason}</dd>
                                </div>
                              )}
                              {detail.summary.error && (
                                <div>
                                  <dt>Error</dt>
                                  <dd>{detail.summary.error}</dd>
                                </div>
                              )}
                            </dl>
                            <pre aria-label="Run configuration">
                              {JSON.stringify(detail.config, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>
      <input
        type="file"
        ref={upload}
        className="visually-hidden"
        aria-label="Import research checkpoint"
        accept=".json,application/json"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      {newConfig && (
        <RunDialog
          initial={newConfig}
          title={configurationTitle}
          maxWorkers={lab.capacity.maxEvaluationWorkers}
          busy={lab.busy}
          onClose={() => setNewConfig(null)}
          onCreate={lab.create}
        />
      )}
    </div>
  );
}
