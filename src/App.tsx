import { boundaryDescription, isDisqualified } from "./research/boundaries";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
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
import { layoutTimeLayers } from "./rendering/volumeData";
import RunDialog from "./components/research/RunDialog";
import RunContextMenu from "./components/research/RunContextMenu";
import { PaneDivider, usePaneSizes } from "./components/research/PaneDivider";
import PopulationView from "./components/research/PopulationView";
import GeneticsView from "./components/research/GeneticsView";
import HistoryView from "./components/research/HistoryView";
import ComparisonView from "./components/research/ComparisonView";
import { useResearch } from "./useResearch";
import { DEFAULT_RUN_CONFIG } from "./research/config";
import { download, request } from "./research/api";
import { decodePreview } from "./research/preview";
import {
  galleryCandidates,
  galleryIndex,
  galleryNeighbors,
} from "./research/gallery";
import { useNeighborPreviews } from "./research/useNeighborPreviews";
import { duration, fitnessNumber, number, time } from "./research/format";
import { parseExperiment } from "./experiment";
import type {
  GenerationSnapshot,
  Individual,
  PreviewFrame,
  PreviewRange,
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
  const [runMenu, setRunMenu] = useState<{
    id: string;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const menuRun = lab.runs.find((value) => value.id === runMenu?.id);
  function closeRunMenu() {
    runMenu?.trigger.focus();
    setRunMenu(null);
  }
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
  const [galleryCursor, setGalleryCursor] = useState<string | null>(null);
  const [galleryVisible, setGalleryVisible] = useState<number[]>([]);
  const [frameContext, setFrameContext] = useState("");
  const [storedFrame, setFrame] = useState<PreviewFrame | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [previewRange, setPreviewRange] = useState<PreviewRange | undefined>();
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState("");
  const [fixtureSeed, setFixtureSeed] = useState<number | null>(null);
  const [visibleLayers, setVisibleLayers] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [loopAnimation, setLoopAnimation] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(4);
  const playingIntent = useRef(true);
  function stopPlayback() {
    playingIntent.current = false;
    setPlaying(false);
  }
  const [displayMode, setDisplayMode] = useState<"volume" | "slice">("volume");
  const [view, setView] = useState<"iso" | "top" | "front">("iso");
  const [material, setMaterial] = useState<"voxels" | "points">("voxels");
  const [palette, setPalette] = useState<"mineral" | "ember" | "ink">(
    "mineral",
  );
  const [grain, setGrain] = useState(true);
  const [annotations, setAnnotations] = useState(false);
  const [compressTime, setCompressTime] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [viewOptions, setViewOptions] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [localError, setLocalError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const detail = lab.detail;
  const run = detail?.summary;
  const panes = usePaneSizes({
    metrics: Boolean(detail) && showMetrics && !focus,
    analysis:
      !detail || focus ? "hidden" : showAnalysis ? "expanded" : "collapsed",
  });
  const workingSnapshot = historical ?? detail?.snapshot ?? null;
  const candidates = useMemo(
    () => galleryCandidates(detail, workingSnapshot, source, selected),
    [detail, workingSnapshot, source, selected],
  );
  const candidateIndex = galleryIndex(candidates, galleryCursor);
  const individual = candidates[candidateIndex]?.individual ?? null;
  const genome = individual?.genome ?? detail?.config.seedGenome ?? null;
  const genomeKey = genome?.join(",") ?? "";
  const previewSeed = fixtureSeed ?? detail?.config.trainingSeeds[0] ?? 1729;
  const previewContext = JSON.stringify([
    lab.selectedId,
    previewSeed,
    previewRange,
    detail?.config.size,
    detail?.config.steps,
  ]);
  const currentFrameContext = `${previewContext}:${genomeKey}`;
  const frame = frameContext === currentFrameContext ? storedFrame : null;
  const decoded = useMemo(() => (frame ? decodePreview(frame) : null), [frame]);
  const neighborPreview = useNeighborPreviews({
    context: previewContext,
    runId: lab.selectedId ?? undefined,
    genomes: galleryNeighbors(galleryVisible, candidateIndex)
      .filter((index) => candidates[index])
      .map((index) => candidates[index].individual.genome),
    seed: previewSeed,
    range: previewRange,
    ready: Boolean(frame) && !previewBusy && lab.connection !== "reconnecting",
  });
  const neighbors = galleryNeighbors(galleryVisible, candidateIndex)
    .filter((index) => candidates[index])
    .map((index) => neighborPreview(candidates[index].individual.genome));
  const carouselReady =
    Boolean(decoded) &&
    !previewBusy &&
    neighbors.every((neighbor) => neighbor?.simulation || neighbor?.error);
  const playbackLayers = Math.max(
    decoded?.playbackLayers ?? 1,
    ...neighbors.map((neighbor) => neighbor?.simulation?.playbackLayers ?? 1),
  );
  const fixturesKey = JSON.stringify([
    detail?.config.trainingSeeds,
    detail?.config.validationSeeds,
  ]);
  const fixtureList = useMemo(() => {
    const [training, validation] = JSON.parse(fixturesKey);
    return [...(training ?? []), ...(validation ?? [])] as number[];
  }, [fixturesKey]);
  const emptySimulation = useMemo(
    () => ({ size: detail?.config.size ?? 1, layers: [] }),
    [detail?.config.size],
  );
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
  const timeScale = useMemo(
    () =>
      renderSimulation
        ? layoutTimeLayers(
            renderSimulation.layers.length,
            renderSimulation.layerTimes,
            compressTime,
          ).scale
        : 1,
    [renderSimulation, compressTime],
  );
  const isActive = run ? ACTIVE.includes(run.status) : false;
  const actionError = localError || lab.error;

  useEffect(() => {
    setHistorical(null);
    setRequestedGeneration(null);
    setSelected(null);
    setSource("best");
    setGalleryCursor(null);
    setFixtureSeed(null);
    setFrame(null);
    setPreviewError("");
    setPreviewRange(undefined);
    setRangeStart("0");
    setRangeEnd("");
  }, [lab.selectedId]);

  useEffect(() => {
    if (!lab.selectedId || !genome || !detail) return;
    if (lab.connection === "reconnecting") {
      setPreviewBusy(false);
      return;
    }
    const controller = new AbortController();
    setPreviewBusy(true);
    setPreviewError("");
    void request<PreviewFrame>(
      `/api/runs/${encodeURIComponent(lab.selectedId)}/preview`,
      {
        method: "POST",
        body: JSON.stringify({
          genome,
          seed: previewSeed,
          range: previewRange,
        }),
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        const preview = decodePreview(value);
        setFrame(value);
        setFrameContext(currentFrameContext);
        setVisibleLayers(playingIntent.current ? 1 : preview.playbackLayers);
        // Preserve the camera across fixture loops of the same rule.
        if (storedFrame?.genome.join(",") !== genomeKey)
          setResetKey((key) => key + 1);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          stopPlayback();
          setFrame(null);
          setPreviewError(
            caught instanceof Error ? caught.message : "Preview failed.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewBusy(false);
      });
    return () => controller.abort();
    // Preview follows the genotype, not every generation or metric update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lab.selectedId,
    lab.connection,
    genomeKey,
    previewSeed,
    previewRange,
    detail?.config.size,
    detail?.config.steps,
    previewAttempt,
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
          setGalleryCursor(null);
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
    if (!playing || !carouselReady) return;
    const complete = visibleLayers >= playbackLayers;
    if (complete && !loopAnimation) {
      stopPlayback();
      return;
    }
    const timer = setTimeout(
      () => {
        if (!complete) {
          setVisibleLayers(visibleLayers + 1);
        } else {
          const next =
            fixtureList[
              (fixtureList.indexOf(previewSeed) + 1) % fixtureList.length
            ];
          if (next !== previewSeed) setFixtureSeed(next);
          setVisibleLayers(1);
        }
      },
      complete ? 200 : 100 / playbackSpeed,
    );
    return () => clearTimeout(timer);
  }, [
    playing,
    carouselReady,
    playbackLayers,
    visibleLayers,
    loopAnimation,
    playbackSpeed,
    fixtureList,
    previewSeed,
  ]);

  // Pin the selected record when playback starts, including default autoplay.
  useEffect(() => {
    if (playing && individual) setGalleryCursor(individual.id);
  }, [playing, individual?.id]);

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

  function selectGalleryIndex(index: number) {
    const candidate = candidates[index];
    if (!candidate) return;
    if (index === candidateIndex && previewError)
      setPreviewAttempt((value) => value + 1);
    setGalleryCursor(
      playing || index !== candidates.length - 1
        ? candidate.individual.id
        : null,
    );
  }

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
  function forkParameters() {
    if (!detail) return;
    openNew(
      {
        ...structuredClone(detail.config),
        name: `${detail.config.name.slice(0, 73)} (fork)`,
      },
      "Fork run",
    );
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
    setGalleryCursor(null);
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
            stateCount: 5,
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
    <div
      ref={root}
      style={panes.style}
      className={`research-app ${focus ? "focus-mode" : ""}`}
    >
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
          disabled={!run || lab.busy}
          aria-label="Fork run"
          title="Edit a copy of this run’s parameters and create a fresh run"
          onClick={forkParameters}
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

      {runMenu && menuRun && (
        <RunContextMenu
          run={menuRun}
          x={runMenu.x}
          y={runMenu.y}
          busy={lab.busy}
          onClose={closeRunMenu}
          onAction={(action) => {
            void lab.action(menuRun.id, action).catch(() => {});
            closeRunMenu();
          }}
        />
      )}
      <div className="research-body">
        {showRuns && !focus && (
          <aside
            id="pane-registry"
            className="run-registry"
            aria-label="Run registry"
          >
            <PaneDivider {...panes.divider("registry")} />
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
                    aria-haspopup="menu"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setRunMenu({
                        id: value.id,
                        x: event.clientX || rect.left + 16,
                        y: event.clientY || rect.top + rect.height / 2,
                        trigger: event.currentTarget,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ContextMenu" ||
                        (event.shiftKey && event.key === "F10")
                      ) {
                        event.preventDefault();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setRunMenu({
                          id: value.id,
                          x: rect.left + 16,
                          y: rect.top + rect.height / 2,
                          trigger: event.currentTarget,
                        });
                      }
                    }}
                  >
                    <div className="run-row-title">
                      <i className={`status-dot ${value.status}`} />
                      <strong>{value.name}</strong>
                    </div>
                    <div className="run-row-meta">
                      <span>
                        {value.generation >= 0
                          ? `g ${number(value.generation)}`
                          : value.status === "queued"
                            ? "Waiting for capacity"
                            : value.status === "starting"
                              ? "Initializing…"
                              : value.status === "failed"
                                ? "Initialization failed"
                                : "Ready to initialize"}
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
              {run?.status === "queued" && (
                <div className="queue-notice" role="status">
                  Queued #{run.queuePosition}: waiting for{" "}
                  {detail.config.evaluationWorkers} evaluators and a
                  coordinator. {lab.capacity.allocatedWorkers} of{" "}
                  {lab.capacity.maxEvaluationWorkers} evaluators are in use.
                  Runs start in queue order when their full worker allocation is
                  available.
                </div>
              )}
              {!focus && showMetrics && (
                <section
                  id="pane-metrics"
                  className="run-metrics"
                  aria-label="Run metrics"
                >
                  <PaneDivider {...panes.divider("metrics")} />
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
                onKeyDown={(event) => {
                  if (
                    event.defaultPrevented ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    (event.target as HTMLElement).closest(
                      "input, select, textarea, [contenteditable=true]",
                    )
                  )
                    return;
                  const index =
                    event.key === "ArrowLeft"
                      ? candidateIndex - 1
                      : event.key === "ArrowRight"
                        ? candidateIndex + 1
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? candidates.length - 1
                            : null;
                  if (index === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  selectGalleryIndex(index);
                }}
              >
                <div className="inspector-toolbar">
                  <select
                    aria-label="Inspected candidate"
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value as typeof source);
                      setGalleryCursor(null);
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
                      ? `${individual.id} · ${fitnessNumber(individual.fitness)}${individual.fixturePasses ? ` · ${individual.fixturePasses.training.filter(Boolean).length}/${individual.fixturePasses.training.length} passed` : individual.disqualified ? " · Fixture failure" : ""}`
                      : "Founder · not evaluated"}
                  </span>
                  <span className="toolbar-space" />
                  {frame && frame.stride > 1 && (
                    <span
                      className="sample-badge"
                      title="This preview came from an older server that skipped timesteps. Refresh after the server update to load every step."
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
                  <div
                    className="fixture-inspector"
                    aria-label="Starting configuration"
                  >
                    <div className="fixture-heading">
                      <span>
                        {detail.config.seed === "soup"
                          ? `Soup ${detail.config.soupSize} × ${detail.config.soupSize}`
                          : "Fixture"}
                      </span>
                      <select
                        aria-label="Preview fixture"
                        value={String(previewSeed)}
                        onChange={(event) => {
                          stopPlayback();
                          setFixtureSeed(Number(event.target.value));
                        }}
                      >
                        {detail.config.trainingSeeds.map((seed, index) => (
                          <option key={`t${seed}`} value={seed}>
                            Train {index + 1} · {seed}
                          </option>
                        ))}
                        {detail.config.validationSeeds.map((seed, index) => (
                          <option key={`v${seed}`} value={seed}>
                            Held-out {index + 1} · {seed}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="fixture-boundaries"
                      aria-label="Fixture boundary contacts"
                      title={
                        frame?.boundaryContacts
                          ? boundaryDescription(
                              frame.boundaryContacts,
                              frame.totalSteps - 1,
                            )
                          : undefined
                      }
                    >
                      {!frame || previewBusy
                        ? previewError
                          ? "Preview unavailable"
                          : "Loading fixture…"
                        : frame.boundaryContacts
                          ? `${
                              isDisqualified(
                                frame.boundaryContacts,
                                detail.config.boundaryPolicy,
                              ) ||
                              (!detail.config.incentives &&
                                (detail.config.objective === "finiteSparse" ||
                                  detail.config.objective === "finiteDense") &&
                                (!frame.simulation.extinct ||
                                  frame.simulation.lifetime === 0))
                                ? "Disqualified · "
                                : ""
                            }${boundaryDescription(frame.boundaryContacts, frame.totalSteps - 1)}`
                          : "Boundary data unavailable"}
                    </div>
                  </div>
                  {genome && (
                    <Volume
                      simulation={renderSimulation ?? emptySimulation}
                      gallery={
                        candidates.length
                          ? {
                              index: candidateIndex,
                              onSelect: selectGalleryIndex,
                              onVisibleChange: setGalleryVisible,
                              items: candidates.map((candidate, index) => {
                                const neighbor = neighborPreview(
                                  candidate.individual.genome,
                                );
                                const simulation =
                                  index === candidateIndex
                                    ? (renderSimulation ?? undefined)
                                    : neighbor?.simulation;
                                return {
                                  id: candidate.individual.id,
                                  label: `g ${candidate.generation} · ${fitnessNumber(candidate.individual.fitness)}`,
                                  simulation:
                                    index === candidateIndex ||
                                    displayMode === "volume" ||
                                    !simulation
                                      ? simulation
                                      : {
                                          size: simulation.size,
                                          layers: [
                                            simulation.layers[
                                              Math.min(
                                                layer,
                                                simulation.layers.length - 1,
                                              )
                                            ],
                                          ],
                                          layerTimes: [
                                            simulation.layerTimes![
                                              Math.min(
                                                layer,
                                                simulation.layers.length - 1,
                                              )
                                            ],
                                          ],
                                        },
                                  error:
                                    index === candidateIndex
                                      ? previewError
                                      : neighbor?.error,
                                };
                              }),
                            }
                          : undefined
                      }
                      visibleLayers={
                        displayMode === "slice" ? 1 : visibleLayers
                      }
                      cutoffTime={
                        displayMode === "volume"
                          ? detail.config.steps - 1
                          : undefined
                      }
                      palette={palette}
                      mode={material}
                      grain={grain}
                      autoRotate={autoRotate}
                      annotations={annotations}
                      compressTime={compressTime}
                      fitMode="specimen"
                      view={displayMode === "slice" ? "top" : view}
                      resetKey={resetKey}
                    />
                  )}
                  {(!frame || previewBusy) && candidates.length === 0 && (
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
                      <button onClick={() => setViewOptions(true)}>
                        Choose time range
                      </button>
                    </div>
                  )}
                  {renderSimulation && displayMode === "volume" && (
                    <span
                      className="time-scale-indicator"
                      aria-label="Time scale"
                      title={
                        compressTime
                          ? `Time axis compressed by ${(1 / timeScale).toFixed(2)}×. Timestamps stay accurate.`
                          : "One CA timestep equals one spatial cell unit."
                      }
                    >
                      {compressTime
                        ? `Time compressed ×${(1 / timeScale).toFixed(1)}`
                        : "Time 1:1"}
                      {frame?.stride === 1 &&
                        ` · Every step · t ${frame.layerTimes[0]}–${frame.layerTimes.at(-1)}`}
                    </span>
                  )}
                  {viewOptions && (
                    <div className="view-options" aria-label="View options">
                      <form
                        className="preview-range"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const start = Number(rangeStart),
                            end = Number(rangeEnd || detail.config.steps - 1);
                          if (start > end) {
                            setPreviewError(
                              "Preview start must be at or before its end.",
                            );
                            return;
                          }
                          setPreviewRange({ start, end });
                        }}
                      >
                        <span>Preview time range · every step</span>
                        <div>
                          <input
                            aria-label="Preview start timestep"
                            type="number"
                            min="0"
                            max={detail.config.steps - 1}
                            required
                            value={rangeStart}
                            onChange={(event) =>
                              setRangeStart(event.target.value)
                            }
                          />
                          <span>–</span>
                          <input
                            aria-label="Preview end timestep"
                            type="number"
                            min="0"
                            max={detail.config.steps - 1}
                            required
                            value={rangeEnd || String(detail.config.steps - 1)}
                            onChange={(event) =>
                              setRangeEnd(event.target.value)
                            }
                          />
                          <button type="submit" disabled={previewBusy}>
                            Apply
                          </button>
                        </div>
                        <button
                          type="button"
                          disabled={!previewRange}
                          onClick={() => {
                            setRangeStart("0");
                            setRangeEnd("");
                            setPreviewRange(undefined);
                          }}
                        >
                          Full horizon
                        </button>
                      </form>
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
                          checked={compressTime}
                          disabled={displayMode === "slice"}
                          onChange={(event) => {
                            setCompressTime(event.target.checked);
                            setResetKey((key) => key + 1);
                          }}
                        />
                        Compress time
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
                {candidates.length > 0 && (
                  <nav
                    className="gallery-navigation"
                    aria-label="Model gallery navigation"
                  >
                    <span className="gallery-order">
                      {source === "best"
                        ? "Record holders · oldest → newest"
                        : source === "generation"
                          ? `Generation ${workingSnapshot?.generation} · fitness →`
                          : "Selected individual"}
                    </span>
                    <span className="gallery-key-hint">← → browse</span>
                    <button
                      aria-label="Previous model"
                      disabled={candidateIndex <= 0}
                      onClick={() => selectGalleryIndex(candidateIndex - 1)}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span
                      className="gallery-position"
                      role="status"
                      aria-label="Gallery position"
                    >
                      {candidateIndex + 1} / {candidates.length}
                    </span>
                    <button
                      aria-label="Next model"
                      disabled={candidateIndex >= candidates.length - 1}
                      onClick={() => selectGalleryIndex(candidateIndex + 1)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </nav>
                )}
                <div className="ca-timeline">
                  <button
                    aria-label={
                      playing ? "Pause CA playback" : "Play CA history"
                    }
                    disabled={!decoded && !playing}
                    onClick={() => {
                      if (
                        !playing &&
                        decoded &&
                        visibleLayers >= playbackLayers
                      )
                        setVisibleLayers(1);
                      if (playing) stopPlayback();
                      else {
                        if (individual) setGalleryCursor(individual.id);
                        playingIntent.current = true;
                        setPlaying(true);
                      }
                    }}
                  >
                    {playing ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                  <span>CA t</span>
                  <input
                    type="range"
                    aria-label="CA timestep"
                    min="1"
                    max={playbackLayers}
                    value={
                      decoded ? Math.min(visibleLayers, playbackLayers) : 1
                    }
                    disabled={!decoded}
                    onChange={(event) => {
                      stopPlayback();
                      setVisibleLayers(Number(event.target.value));
                    }}
                  />
                  <output>
                    {actualTime} /{" "}
                    {decoded?.layerTimes[playbackLayers - 1] ?? 0}
                  </output>
                  <select
                    aria-label="Animation speed"
                    title="Animation speed"
                    value={playbackSpeed}
                    onChange={(event) =>
                      setPlaybackSpeed(Number(event.target.value))
                    }
                  >
                    {[0.5, 1, 2, 4, 8, 16].map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}×
                      </option>
                    ))}
                  </select>
                  <label className="check-field loop-animation">
                    <input
                      type="checkbox"
                      checked={loopAnimation}
                      onChange={(event) =>
                        setLoopAnimation(event.target.checked)
                      }
                    />
                    Loop animation
                  </label>
                </div>
              </section>

              {!focus && (
                <section
                  id="pane-analysis"
                  className={`analysis-pane ${showAnalysis ? "" : "collapsed"}`}
                  aria-label="Genetic analysis"
                >
                  {showAnalysis && (
                    <PaneDivider {...panes.divider("analysis")} />
                  )}
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
                            setGalleryCursor(null);
                          } else if (detail.snapshot) {
                            setHistorical(detail.snapshot);
                            setSource("generation");
                            setGalleryCursor(null);
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
                              setGalleryCursor(null);
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
