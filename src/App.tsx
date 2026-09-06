import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Download,
  Focus,
  Pause,
  Play,
  Settings2,
  SkipForward,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import Volume from "./components/Volume";
import RuleEditor from "./components/RuleEditor";
import { PopulationChart } from "./components/PopulationChart";
import {
  PRESETS,
  genomeId,
  type Config,
  type Objective,
  type SeedMode,
} from "./simulation";
import {
  loadExperiment,
  parseExperiment,
  STORAGE_KEY,
  type Experiment,
} from "./experiment";
import { useEvolution } from "./useEvolution";

const DEFAULT_EXPERIMENT: Experiment = {
  version: 1,
  name: PRESETS[0].name,
  genome: PRESETS[0].genome,
  config: { size: 41, steps: 48, seed: PRESETS[0].seed, randomSeed: 1729 },
};

export default function App() {
  const [initial] = useState(() => loadExperiment() ?? DEFAULT_EXPERIMENT);
  const vm = useEvolution(initial);
  const [panel, setPanel] = useState<"controls" | "diagnostics" | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [palette, setPalette] = useState<"mineral" | "ember" | "ink">(
    "mineral",
  );
  const [mode, setMode] = useState<"voxels" | "points">("voxels");
  const [grain, setGrain] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [annotations, setAnnotations] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [visibleLayers, setVisibleLayers] = useState(initial.config.steps);
  const [playing, setPlaying] = useState(false);
  const [fileError, setFileError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const { experiment, simulation, settings } = vm;
  const depth = simulation?.layers.length ?? experiment.config.steps;
  const currentLayer = Math.min(depth, visibleLayers);
  const busy = vm.running || vm.pending || vm.connection !== "ready";
  const selectedPreset =
    PRESETS.find(
      (preset) =>
        preset.seed === experiment.config.seed &&
        preset.genome.every((gene, index) => gene === experiment.genome[index]),
    )?.id ?? "custom";

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(experiment));
    } catch {
      /* Optional local persistence. */
    }
  }, [experiment]);
  useEffect(() => {
    if (simulation) setVisibleLayers(simulation.layers.length);
    setPlaying(false);
  }, [simulation]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () => setVisibleLayers((layer) => Math.min(depth, layer + 1)),
      130,
    );
    return () => clearInterval(timer);
  }, [playing, depth]);
  useEffect(() => {
    if (playing && currentLayer >= depth) setPlaying(false);
  }, [playing, currentLayer, depth]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (ruleOpen) return;
      if (event.key === "Escape") {
        setPanel(null);
        return;
      }
      if (
        (event.target as HTMLElement).matches(
          "input, select, button, textarea, summary, [contenteditable=true]",
        )
      )
        return;
      if (event.code === "Space" && vm.connection === "ready") {
        event.preventDefault();
        setPlaying(false);
        if (vm.running) vm.pause();
        else if (!vm.pending) vm.start();
      }
      if (event.key === "." && !busy) {
        event.preventDefault();
        vm.step();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vm, busy, ruleOpen]);

  function updateConfig(update: Partial<Config>) {
    setPlaying(false);
    vm.replace({ ...experiment, config: { ...experiment.config, ...update } });
  }
  function selectPreset(id: string) {
    const preset = PRESETS.find((preset) => preset.id === id);
    if (!preset) return;
    vm.replace({
      version: 1,
      genome: [...preset.genome],
      name: preset.name,
      config: { ...experiment.config, seed: preset.seed },
    });
  }
  function save() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(experiment, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `polyp-${genomeId(experiment.genome)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function load(file?: File) {
    if (!file) return;
    try {
      if (file.size > 100_000) throw new Error("File exceeds 100 KB.");
      vm.replace(parseExperiment(await file.text()));
      setFileError("");
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : "Invalid experiment.",
      );
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  function toggleRun() {
    setPlaying(false);
    if (vm.running) vm.pause();
    else vm.start();
  }
  const error = fileError || vm.error;

  return (
    <div className="dev-environment">
      <header className="toolbar" aria-label="Evolution controls">
        <button
          className="run-button"
          disabled={!vm.running && (vm.connection !== "ready" || vm.pending)}
          onClick={toggleRun}
          aria-label={vm.running ? "Pause evolution" : "Run evolution"}
          aria-keyshortcuts="Space"
          title="Run / pause · Space"
        >
          {vm.running ? <Pause size={14} /> : <Play size={14} />}
          {vm.running ? "Pause" : "Run"}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setPlaying(false);
            vm.step();
          }}
          aria-label="Step evolution"
          aria-keyshortcuts="."
          title="One evolution epoch · ."
        >
          <SkipForward size={15} />
          <span className="button-label">Step</span>
        </button>
        <span className="toolbar-divider" />
        <button
          aria-label="Toggle controls"
          aria-expanded={panel === "controls"}
          className={panel === "controls" ? "selected" : ""}
          onClick={() => setPanel(panel === "controls" ? null : "controls")}
          title="Controls"
        >
          <Settings2 size={15} />
          <span className="button-label">Controls</span>
        </button>
        <button
          aria-label="Toggle diagnostics"
          aria-expanded={panel === "diagnostics"}
          className={panel === "diagnostics" ? "selected" : ""}
          onClick={() =>
            setPanel(panel === "diagnostics" ? null : "diagnostics")
          }
          title="Diagnostics"
        >
          <Activity size={15} />
          <span className="button-label">Diagnostics</span>
        </button>
        <span className="toolbar-space" />
        <button
          aria-label="Edit rule"
          title="Edit rule"
          disabled={vm.pending}
          onClick={() => {
            vm.pause();
            setPlaying(false);
            setRuleOpen(true);
          }}
        >
          <SlidersHorizontal size={15} />
          <span className="button-label">Rule</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          className="visually-hidden"
          aria-label="Import experiment file"
          accept=".json,application/json"
          onChange={(event) => void load(event.target.files?.[0])}
        />
        <button
          aria-label="Load experiment"
          title="Load JSON"
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={15} />
        </button>
        <button aria-label="Save experiment" title="Save JSON" onClick={save}>
          <Download size={15} />
        </button>
        <button
          aria-label="Reset camera"
          title="Reset camera"
          onClick={() => setResetKey((key) => key + 1)}
        >
          <Focus size={15} />
        </button>
        <span className="toolbar-divider" />
        {vm.connection === "disconnected" ? (
          <button
            className="reconnect-button"
            onClick={vm.reconnect}
            title="Reconnect to VM"
          >
            Reconnect
          </button>
        ) : (
          <span
            className={`connection-indicator ${vm.connection}`}
            role="status"
            aria-label={
              vm.connection === "ready" ? "VM connected" : "Connecting to VM"
            }
            title={
              vm.connection === "ready"
                ? "Connected to VM worker"
                : "Connecting to VM"
            }
          >
            <i />
            <span className="connection-label">VM</span>
          </span>
        )}
      </header>

      <main className="viewport" aria-label="Cellular automaton spacetime">
        {simulation ? (
          <Volume
            simulation={simulation}
            visibleLayers={currentLayer}
            palette={palette}
            mode={mode}
            grain={grain}
            autoRotate={autoRotate}
            annotations={annotations}
            resetKey={resetKey}
            onLayerSelect={(layer) => {
              if (!busy) {
                setPlaying(false);
                setVisibleLayers(layer + 1);
              }
            }}
          />
        ) : (
          <div className="viewport-status" role="status">
            {vm.connection === "disconnected"
              ? "VM disconnected"
              : "Connecting to VM…"}
          </div>
        )}
        {simulation && vm.pending && !vm.running && (
          <span className="pending-indicator" role="status">
            Evaluating…
          </span>
        )}
        {error && (
          <div className="error-message" role="alert">
            <span>{error}</span>
            <button
              aria-label="Dismiss error"
              onClick={() => {
                setFileError("");
                vm.clearError();
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {panel && (
          <aside
            className="utility-panel"
            aria-label={panel === "controls" ? "Controls" : "Diagnostics"}
          >
            <div className="panel-header">
              <span>{panel === "controls" ? "Controls" : "Diagnostics"}</span>
              <button aria-label="Close panel" onClick={() => setPanel(null)}>
                <X size={15} />
              </button>
            </div>
            {panel === "controls" ? (
              <div className="panel-body">
                <details open>
                  <summary>Evolution</summary>
                  <label className="field">
                    <span>Objective</span>
                    <select
                      aria-label="Objective"
                      value={settings.objective}
                      onChange={(event) =>
                        vm.configure({
                          objective: event.target.value as Objective,
                        })
                      }
                    >
                      <option value="complexity">Complexity</option>
                      <option value="longevity">Finite longevity</option>
                      <option value="growth">Growth</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Mutation</span>
                    <div className="range-field">
                      <input
                        aria-label="Mutation rate"
                        type="range"
                        min="0"
                        max="0.3"
                        step="0.01"
                        value={settings.mutationRate}
                        onChange={(event) =>
                          vm.configure({
                            mutationRate: Number(event.target.value),
                          })
                        }
                      />
                      <output>
                        {Math.round(settings.mutationRate * 100)}%
                      </output>
                    </div>
                  </label>
                  <label className="field">
                    <span>Search seed</span>
                    <input
                      aria-label="Search seed"
                      type="number"
                      step="1"
                      value={settings.randomSeed}
                      onChange={(event) => {
                        const n = event.target.valueAsNumber;
                        if (Number.isSafeInteger(n))
                          vm.configure({ randomSeed: n });
                      }}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setPlaying(false);
                      vm.reset();
                    }}
                  >
                    Reset search
                  </button>
                </details>
                <details open>
                  <summary>Initial conditions</summary>
                  <label className="field">
                    <span>Rule preset</span>
                    <select
                      aria-label="Rule preset"
                      value={selectedPreset}
                      onChange={(event) => selectPreset(event.target.value)}
                    >
                      <option value="custom" disabled>
                        Custom
                      </option>
                      {PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Seed pattern</span>
                    <select
                      aria-label="Seed pattern"
                      value={experiment.config.seed}
                      onChange={(event) =>
                        updateConfig({ seed: event.target.value as SeedMode })
                      }
                    >
                      <option value="point">Point</option>
                      <option value="cross">Cross</option>
                      <option value="islands">Islands</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Seed</span>
                    <input
                      aria-label="Initial seed"
                      type="number"
                      step="1"
                      value={experiment.config.randomSeed}
                      onChange={(event) => {
                        const n = event.target.valueAsNumber;
                        if (Number.isSafeInteger(n))
                          updateConfig({ randomSeed: n });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Grid</span>
                    <select
                      aria-label="Grid size"
                      value={experiment.config.size}
                      onChange={(event) =>
                        updateConfig({ size: Number(event.target.value) })
                      }
                    >
                      {[25, 33, 41, 49].map((size) => (
                        <option key={size} value={size}>
                          {size} × {size}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Time depth</span>
                    <select
                      aria-label="Time depth"
                      value={experiment.config.steps}
                      onChange={(event) =>
                        updateConfig({ steps: Number(event.target.value) })
                      }
                    >
                      {[24, 32, 48, 64].map((steps) => (
                        <option key={steps} value={steps}>
                          {steps}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
                <details>
                  <summary>View</summary>
                  <label className="field">
                    <span>Rendering</span>
                    <select
                      aria-label="Rendering"
                      value={mode}
                      onChange={(event) =>
                        setMode(event.target.value as typeof mode)
                      }
                    >
                      <option value="voxels">Voxels</option>
                      <option value="points">Points</option>
                    </select>
                  </label>
                  <label className="field">
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
                    Dither / grain
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={autoRotate}
                      onChange={(event) => setAutoRotate(event.target.checked)}
                    />
                    Rotate
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={annotations}
                      onChange={(event) => setAnnotations(event.target.checked)}
                    />
                    Reference grid
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={showTimeline}
                      onChange={(event) => {
                        setShowTimeline(event.target.checked);
                        setPlaying(false);
                      }}
                    />
                    Timeline
                  </label>
                </details>
              </div>
            ) : (
              <div className="panel-body">
                <dl className="diagnostics-list">
                  <div>
                    <dt>Execution</dt>
                    <dd>VM / thread {vm.execution?.threadId ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Epoch</dt>
                    <dd>{vm.epoch}</dd>
                  </div>
                  <div>
                    <dt>Fitness</dt>
                    <dd>{vm.score === null ? "—" : vm.score.toFixed(5)}</dd>
                  </div>
                  <div>
                    <dt>Objective</dt>
                    <dd>{settings.objective}</dd>
                  </div>
                  <div>
                    <dt>Rule</dt>
                    <dd>{genomeId(experiment.genome)}</dd>
                  </div>
                  <div>
                    <dt>Occupied / layer</dt>
                    <dd>{simulation?.population[currentLayer - 1] ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Activity</dt>
                    <dd>{simulation?.activity.toFixed(5) ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>State diversity</dt>
                    <dd>{simulation?.diversity.toFixed(5) ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Lifetime</dt>
                    <dd>
                      {simulation
                        ? `${simulation.lifetime}${simulation.extinct ? "" : "+"}`
                        : "—"}
                    </dd>
                  </div>
                </dl>
                {vm.history.length > 1 && (
                  <div className="fitness-history">
                    <span>Fitness</span>
                    <PopulationChart
                      values={vm.history}
                      progress={1}
                      evolution
                    />
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </main>

      {showTimeline && (
        <footer className="timeline" aria-label="Time controls">
          <button
            disabled={busy || !simulation}
            aria-label={playing ? "Pause time" : "Play time"}
            title={playing ? "Pause time" : "Play time"}
            onClick={() => {
              if (!playing && currentLayer >= depth) setVisibleLayers(1);
              setPlaying((value) => !value);
            }}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <input
            aria-label="Visible time layer"
            type="range"
            min="1"
            max={depth}
            value={currentLayer}
            disabled={busy || !simulation}
            onChange={(event) => {
              setPlaying(false);
              setVisibleLayers(Number(event.target.value));
            }}
          />
          <output>
            {currentLayer - 1}/{depth - 1}
          </output>
        </footer>
      )}
      <RuleEditor
        open={ruleOpen}
        genome={experiment.genome}
        onClose={() => setRuleOpen(false)}
        onApply={(genome) =>
          vm.replace({ ...experiment, genome, name: "Custom" })
        }
      />
    </div>
  );
}
