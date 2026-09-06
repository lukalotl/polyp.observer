import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  Dices,
  Focus,
  GitBranch,
  Grid2X2,
  Layers3,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Rotate3D,
  Scan,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import Volume from "./components/Volume";
import RuleEditor from "./components/RuleEditor";
import { trapDialogTab } from "./dialogFocus";
import { PALETTES } from "./rendering/materials";
import { SpecimenPreview } from "./components/SpecimenPreview";
import { PopulationChart } from "./components/PopulationChart";
import {
  PRESETS,
  simulate,
  fitness,
  mutate,
  genomeId,
  type Config,
  type EvolutionResult,
  type Objective,
  type SeedMode,
} from "./simulation";
import {
  loadExperiment,
  parseExperiment,
  STORAGE_KEY,
  type Experiment,
} from "./experiment";

const DEFAULT_CONFIG: Config = {
  size: 41,
  steps: 48,
  seed: PRESETS[0].seed,
  randomSeed: 1729,
};
const initialExperiment = loadExperiment();
const format = (n: number) => n.toLocaleString("en-US");

export default function App() {
  const [genome, setGenome] = useState(
    initialExperiment?.genome ?? PRESETS[0].genome,
  );
  const [config, setConfig] = useState<Config>(
    initialExperiment?.config ?? DEFAULT_CONFIG,
  );
  const [name, setName] = useState(initialExperiment?.name ?? PRESETS[0].name);
  const [tab, setTab] = useState<"observe" | "evolve">("observe");
  const [selectedPreset, setSelectedPreset] = useState(
    initialExperiment ? "" : PRESETS[0].id,
  );
  const [palette, setPalette] = useState<"mineral" | "ember" | "ink">(
    "mineral",
  );
  const [mode, setMode] = useState<"voxels" | "points">("voxels");
  const [grain, setGrain] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [visibleLayers, setVisibleLayers] = useState(config.steps);
  const [playing, setPlaying] = useState(false);
  const [objective, setObjective] = useState<Objective>("complexity");
  const [mutationRate, setMutationRate] = useState(0.08);
  const [evolving, setEvolving] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [fitnessHistory, setFitnessHistory] = useState<number[]>([]);
  const [notice, setNotice] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const runSeed = useRef(1729);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const observatoryRef = useRef<HTMLDivElement>(null);
  const simulation = useMemo(() => simulate(genome, config), [genome, config]);
  const score = fitness(simulation, objective);
  const id = genomeId(genome);
  const currentLayer = Math.min(visibleLayers, simulation.layers.length);
  const occupied = simulation.population[currentLayer - 1] ?? 0;
  const stateCounts = useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    simulation.layers[currentLayer - 1]?.forEach((state) => {
      counts[state]++;
    });
    return counts;
  }, [simulation, currentLayer]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, genome, config, name }),
      );
    } catch {
      /* Storage is optional. */
    }
  }, [genome, config, name]);
  useEffect(() => {
    setVisibleLayers(config.steps);
    setPlaying(false);
  }, [config, genome]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () =>
        setVisibleLayers((layer) => {
          if (layer >= config.steps) {
            setPlaying(false);
            return config.steps;
          }
          return layer + 1;
        }),
      130,
    );
    return () => window.clearInterval(timer);
  }, [playing, config.steps]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const container = observatoryRef.current;
    container
      ?.querySelector<HTMLElement>('[aria-label="Exit expanded view"]')
      ?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !container) return;
      const controls = Array.from(
        container.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (
        !container.contains(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [expanded]);
  useEffect(() => {
    if (aboutOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [aboutOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (
        event.code !== "Space" ||
        aboutOpen ||
        ruleOpen ||
        evolving ||
        (event.target as HTMLElement).matches("input, select, button, textarea")
      )
        return;
      event.preventDefault();
      setPlaying((value) => {
        if (!value && visibleLayers >= config.steps) setVisibleLayers(1);
        return !value;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aboutOpen, ruleOpen, config.steps, evolving, visibleLayers]);
  useEffect(() => {
    if (!evolving) return;
    let disposed = false;
    let nextGenome = genome;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./evolution.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      setNotice(
        "Evolution is unavailable in this browser. Your specimen is safe.",
      );
      setEvolving(false);
      return;
    }
    workerRef.current = worker;
    const send = () => {
      try {
        worker.postMessage({
          genome: nextGenome,
          config,
          objective,
          mutationRate,
          randomSeed: ++runSeed.current,
        });
      } catch {
        setNotice("Evolution could not start. Your specimen is safe.");
        setEvolving(false);
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    worker.onmessage = (
      event: MessageEvent<{ result?: EvolutionResult; error?: string }>,
    ) => {
      if (disposed) return;
      if (event.data.error || !event.data.result) {
        setNotice(event.data.error ?? "Evolution could not finish.");
        setEvolving(false);
        return;
      }
      const result = event.data.result;
      nextGenome = result.genome;
      setGenome(result.genome);
      setName("Evolved form");
      setSelectedPreset("");
      setEpoch((value) => value + 1);
      setFitnessHistory((values) => [...values, result.fitness].slice(-100));
      timer = setTimeout(send, 180);
    };
    worker.onerror = () => {
      if (!disposed) {
        setNotice(
          "The evolution worker stopped. Your specimen is safe; try again.",
        );
        setEvolving(false);
      }
    };
    send();
    return () => {
      disposed = true;
      clearTimeout(timer);
      worker.terminate();
      workerRef.current = null;
    };
    // Each run captures a fixed environment. Controls stop the run before changing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evolving]);

  function resetEvolution() {
    setEvolving(false);
    setEpoch(0);
    setFitnessHistory([]);
  }
  function updateConfig(update: Partial<Config>) {
    resetEvolution();
    setConfig((value) => ({ ...value, ...update }));
  }
  function selectPreset(index: number) {
    const preset = PRESETS[index];
    resetEvolution();
    setGenome([...preset.genome]);
    setName(preset.name);
    setSelectedPreset(preset.id);
    setConfig((value) => ({ ...value, seed: preset.seed, randomSeed: 1729 }));
  }
  function mutateRule() {
    resetEvolution();
    const seed = ++runSeed.current;
    setGenome((value) => {
      const next = mutate(value, mutationRate, seed);
      // Manual exploration always changes at least one gene, even if the
      // Bernoulli sampler selected none. Genetic search retains neutral trials.
      if (next.every((gene, index) => gene === value[index])) {
        const index = 1 + (seed % 44);
        next[index] = (next[index] + 1 + (seed % 4)) % 5;
      }
      return next;
    });
    setName("Mutant form");
    setSelectedPreset("");
    setNotice("Rule mutated. A new genotype, a new history.");
  }
  function exportSpecimen() {
    const specimen: Experiment = { version: 1, genome, config, name };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(specimen, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `polyp-${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Specimen exported with its rule and reproducible seed.");
  }
  async function importSpecimen(file?: File) {
    if (!file) return;
    try {
      if (file.size > 100_000)
        throw new Error("Specimen files must be smaller than 100 KB.");
      const data = parseExperiment(await file.text());
      resetEvolution();
      setGenome(data.genome);
      setConfig(data.config);
      setName(data.name);
      setSelectedPreset("");
      setNotice("Specimen imported.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not import this specimen.",
      );
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  function toggleEvolution() {
    if (!evolving && !fitnessHistory.length) setFitnessHistory([score]);
    setPlaying(false);
    setEvolving((value) => !value);
  }
  const progress = (currentLayer - 1) / Math.max(config.steps - 1, 1);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          href="#"
          className="brand"
          aria-label="Polyp Observer home"
          onClick={(event) => {
            event.preventDefault();
            setTab("observe");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">
            polyp<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <span className="brand-descriptor">
            AN OBSERVATORY
            <br />
            FOR ARTIFICIAL LIFE
          </span>
        </a>
        <nav className="main-nav" aria-label="Workspace">
          <button
            aria-pressed={tab === "observe"}
            className={tab === "observe" ? "active" : ""}
            onClick={() => setTab("observe")}
          >
            <span>01</span> Observatory
          </button>
          <button
            aria-pressed={tab === "evolve"}
            className={tab === "evolve" ? "active" : ""}
            onClick={() => setTab("evolve")}
          >
            <span>02</span> Evolution <span className="nav-dot" />
          </button>
        </nav>
        <button className="about-button" onClick={() => setAboutOpen(true)}>
          The idea behind it <ArrowUpRight size={15} />
        </button>
      </header>

      <main className="workspace">
        <aside className="control-panel">
          <div className="intro">
            <div className="eyebrow">
              <span className="tiny-cross">✳</span> SIMPLE SYSTEMS / COMPLEX
              BEHAVIOR
            </div>
            <h1>
              Small rules.
              <br /> Endless <em>forms.</em>
            </h1>
            <p>
              A little universe, grown from a rule.
              <br />
              Explore life in two dimensions.
              <br />
              See its history in three.
            </p>
          </div>
          <section className="control-section">
            <div className="section-heading">
              <span>01 / INITIAL CONDITIONS</span>
              <Scan size={14} />
            </div>
            <label className="field-label">
              Seed pattern <span>t = 0</span>
            </label>
            <div className="segmented seed-options">
              {(["point", "cross", "islands"] as SeedMode[]).map(
                (seed, index) => (
                  <button
                    key={seed}
                    aria-pressed={config.seed === seed}
                    onClick={() => updateConfig({ seed })}
                    className={config.seed === seed ? "selected" : ""}
                  >
                    {index === 0 ? (
                      <span className="point-icon" />
                    ) : index === 1 ? (
                      <Plus size={14} />
                    ) : (
                      <Grid2X2 size={13} />
                    )}
                    <span>
                      {seed === "point"
                        ? "Point"
                        : seed === "cross"
                          ? "Cross"
                          : "Islands"}
                    </span>
                  </button>
                ),
              )}
            </div>
            <div className="field-pair">
              <label className="select-field">
                <span>World size</span>
                <div>
                  <select
                    aria-label="World size"
                    value={config.size}
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
                  <ChevronDown size={13} />
                </div>
              </label>
              <label className="select-field">
                <span>Time depth</span>
                <div>
                  <select
                    aria-label="Time depth"
                    value={config.steps}
                    onChange={(event) =>
                      updateConfig({ steps: Number(event.target.value) })
                    }
                  >
                    {[24, 32, 48, 64].map((steps) => (
                      <option key={steps} value={steps}>
                        {steps} layers
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </div>
              </label>
            </div>
          </section>
          <section className="control-section">
            <div className="section-heading">
              <span>
                02 /{" "}
                {tab === "evolve" ? "NATURAL SELECTION" : "THE RULE OF LIFE"}
              </span>
              <GitBranch size={14} />
            </div>
            <div className="rule-summary">
              <span className="rule-icon">
                <Layers3 size={20} strokeWidth={1.3} />
              </span>
              <div>
                <strong>Five states. One neighborhood.</strong>
                <span>2D · Moore · outer-totalistic</span>
              </div>
            </div>
            <button
              className="genome"
              aria-label="Edit rule genome"
              title="Edit the 45 genes: current state × occupied neighbor count."
              onClick={() => {
                setEvolving(false);
                setRuleOpen(true);
              }}
            >
              {genome.map((gene, i) => (
                <span key={i} className={`gene gene-${gene}`} />
              ))}
            </button>
            <div className="gene-caption">
              <span>GENOTYPE / {id}</span>
              <button
                onClick={() => {
                  setEvolving(false);
                  setRuleOpen(true);
                }}
              >
                45 GENES / EDIT ↗
              </button>
            </div>
            {tab === "evolve" && (
              <label className="select-field objective-field">
                <span>Selection pressure</span>
                <div>
                  <select
                    aria-label="Selection pressure"
                    value={objective}
                    onChange={(event) => {
                      resetEvolution();
                      setObjective(event.target.value as Objective);
                    }}
                  >
                    <option value="complexity">Complexity & diversity</option>
                    <option value="longevity">Finite longevity</option>
                    <option value="growth">Spatial growth</option>
                  </select>
                  <ChevronDown size={13} />
                </div>
              </label>
            )}
            <label
              className="field-label mutation-label"
              htmlFor="mutation-rate"
            >
              Mutation rate <span>{Math.round(mutationRate * 100)}%</span>
            </label>
            <input
              id="mutation-rate"
              className="range"
              type="range"
              min="0.02"
              max="0.3"
              step="0.01"
              value={mutationRate}
              onChange={(event) => {
                setEvolving(false);
                setMutationRate(Number(event.target.value));
              }}
            />
            <button
              className="primary-button"
              onClick={tab === "evolve" ? toggleEvolution : mutateRule}
            >
              {tab === "evolve" ? (
                evolving ? (
                  <Pause size={16} />
                ) : (
                  <Play size={16} />
                )
              ) : (
                <Dices size={17} />
              )}
              <span>
                {tab === "evolve"
                  ? evolving
                    ? "Pause evolution"
                    : "Run evolution"
                  : "Mutate this rule"}
              </span>
              {evolving ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}
            </button>
            <p className="control-hint">
              {tab === "evolve"
                ? "Selection, crossover, mutation. Better rules survive."
                : "A small change can make a different world."}
            </p>
          </section>
          <section className="control-section appearance-section">
            <div className="section-heading">
              <span>03 / MATERIAL & LIGHT</span>
              <Sparkles size={14} />
            </div>
            <div className="material-row">
              <span>Palette</span>
              <div className="palette-options">
                {(["mineral", "ember", "ink"] as const).map((p) => (
                  <button
                    key={p}
                    className={`palette-swatch ${p} ${palette === p ? "selected" : ""}`}
                    aria-label={`${p} palette`}
                    aria-pressed={palette === p}
                    title={p}
                    onClick={() => setPalette(p)}
                  >
                    {palette === p && <Check size={13} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="material-row">
              <span>Dither & grain</span>
              <button
                className={`toggle ${grain ? "on" : ""}`}
                role="switch"
                aria-checked={grain}
                aria-label="Dither and grain"
                onClick={() => setGrain((value) => !value)}
              >
                <span />
              </button>
            </div>
            <div className="material-row">
              <span>Slow orbit</span>
              <button
                className={`toggle ${autoRotate ? "on" : ""}`}
                role="switch"
                aria-checked={autoRotate}
                aria-label="Slow orbit"
                onClick={() => setAutoRotate((value) => !value)}
              >
                <span />
              </button>
            </div>
          </section>
          <div className="sidebar-foot">
            <span className="status-dot" /> LOCAL SIMULATION{" "}
            <span>NO TWO WORLDS ALIKE.</span>
          </div>
        </aside>

        <div
          ref={observatoryRef}
          role={expanded ? "dialog" : undefined}
          aria-modal={expanded || undefined}
          aria-label={expanded ? "Expanded observatory" : undefined}
          className={`observatory ${expanded ? "expanded" : ""}`}
        >
          <section
            className={`stage palette-${palette} ${grain ? "with-grain" : ""}`}
            aria-label="Interactive 3D spacetime volume"
          >
            <Volume
              simulation={simulation}
              visibleLayers={currentLayer}
              palette={palette}
              mode={mode}
              grain={grain}
              autoRotate={autoRotate}
              resetKey={resetKey}
              onLayerSelect={(layer) => {
                setPlaying(false);
                setVisibleLayers(layer + 1);
              }}
            />
            <div className="stage-grain" aria-hidden="true" />
            <div className="stage-header">
              <div>
                <div className="stage-eyebrow">SPECIMEN / {id}</div>
                <h2>
                  {name}
                  <span>
                    {" "}
                    {selectedPreset
                      ? String(
                          PRESETS.findIndex((p) => p.id === selectedPreset) + 1,
                        ).padStart(2, "0")
                      : "↗"}
                  </span>
                </h2>
                <p>
                  {evolving
                    ? "Searching the space of possible life."
                    : "An unfolding record of artificial life."}
                </p>
              </div>
              <div className="stage-badge">
                <span
                  className={`status-dot ${evolving || playing ? "pulse" : ""}`}
                />
                {evolving
                  ? "EVOLVING"
                  : playing
                    ? "UNFOLDING"
                    : "LIVE SIMULATION"}
              </div>
            </div>
            <div className="stage-tools">
              <div className="tool-group">
                <button
                  aria-label="Voxel rendering"
                  title="Voxels"
                  aria-pressed={mode === "voxels"}
                  className={mode === "voxels" ? "active" : ""}
                  onClick={() => setMode("voxels")}
                >
                  <Box size={17} />
                </button>
                <button
                  aria-label="Point rendering"
                  title="Points"
                  aria-pressed={mode === "points"}
                  className={mode === "points" ? "active" : ""}
                  onClick={() => setMode("points")}
                >
                  <Grid2X2 size={16} />
                </button>
              </div>
              <div className="tool-group">
                <button
                  aria-label="Reset camera"
                  title="Reset view"
                  onClick={() => setResetKey((value) => value + 1)}
                >
                  <Focus size={17} />
                </button>
                <button
                  aria-label={expanded ? "Exit expanded view" : "Expand view"}
                  title={expanded ? "Exit expanded view" : "Expand view"}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? <X size={17} /> : <Maximize2 size={16} />}
                </button>
              </div>
            </div>
            {occupied === 0 && (
              <div className="extinction-note">
                <span>∅</span> No occupied cells at this layer.
                <br />
                <small>
                  Its history remains below. Try another rule or seed.
                </small>
              </div>
            )}
            <div className="stage-footer">
              <div className="orbit-hint">
                <Rotate3D size={15} />
                <span>
                  DRAG TO ORBIT <i /> SCROLL TO ZOOM
                </span>
              </div>
              <div className="stage-scale">
                <span>
                  {config.size} × {config.size} × {config.steps}
                </span>
                <span>SPACE × TIME</span>
              </div>
            </div>
            <div className="axis-key" aria-hidden="true">
              <svg viewBox="0 0 65 70">
                <path d="M30 46V12M30 46 7 57M30 46 54 57" />
                <text x="26" y="9">
                  t
                </text>
                <text x="0" y="65">
                  x
                </text>
                <text x="56" y="65">
                  y
                </text>
                <circle cx="30" cy="46" r="2" />
              </svg>
            </div>
          </section>

          <section className="timeline-section" aria-label="Time explorer">
            <div className="timeline-top">
              <div className="timeline-label">
                <span className="mini-icon">
                  <Layers3 size={16} />
                </span>
                <strong>Time is a dimension.</strong>
                <span>Move through the history.</span>
              </div>
              <div className="generation-label">
                LAYER{" "}
                <strong>{String(currentLayer - 1).padStart(2, "0")}</strong>
                <span>/ {config.steps - 1}</span>
              </div>
            </div>
            <div className="timeline-controls">
              <button
                className="play-button"
                disabled={evolving}
                aria-label={playing ? "Pause time" : "Play time"}
                onClick={() => {
                  if (!playing && currentLayer >= config.steps)
                    setVisibleLayers(1);
                  setPlaying((value) => !value);
                }}
              >
                {playing ? (
                  <Pause size={15} fill="currentColor" />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}
              </button>
              <div className="timeline-track">
                <PopulationChart
                  values={simulation.population}
                  progress={progress}
                />
                <input
                  aria-label="Visible time layer"
                  disabled={evolving}
                  className="range timeline-range"
                  type="range"
                  min="1"
                  max={config.steps}
                  value={currentLayer}
                  onChange={(event) => {
                    setPlaying(false);
                    setVisibleLayers(Number(event.target.value));
                  }}
                />
                <div className="timeline-ticks">
                  <span>0 · SEED</span>
                  <span>{Math.floor(config.steps / 4)}</span>
                  <span>{Math.floor(config.steps / 2)}</span>
                  <span>{Math.floor((config.steps * 3) / 4)}</span>
                  <span>{config.steps - 1} · PRESENT</span>
                </div>
              </div>
              <button
                className="end-button"
                aria-label="Show all time layers"
                title="Show entire history"
                onClick={() => {
                  setPlaying(false);
                  setVisibleLayers(config.steps);
                }}
              >
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
          <section className="metrics-bar" aria-label="Simulation statistics">
            <div>
              <span className="metric-label">OCCUPIED / LAYER</span>
              <strong>
                {format(occupied)} <small>cells</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">STATE DIVERSITY</span>
              <strong>
                {Math.round(simulation.diversity * 100)}
                <small>%</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">
                {tab === "evolve" ? "EPOCH / FITNESS" : "RULE BOUNDARY"}
              </span>
              <strong className="text-metric">
                {tab === "evolve"
                  ? `${String(epoch).padStart(3, "0")} / ${(score * 100).toFixed(1)}%`
                  : "Fixed · quiescent"}
              </strong>
            </div>
            <div
              className="state-legend"
              aria-label="Current layer state distribution"
            >
              {[1, 2, 3, 4].map((state) => (
                <span
                  key={state}
                  title={`State ${state}: ${stateCounts[state]} cells`}
                >
                  <i
                    className="state-color"
                    style={{ backgroundColor: PALETTES[palette][state - 1] }}
                  />
                  {state}
                </span>
              ))}
              <span className="void-label">0 = VOID</span>
            </div>
          </section>
          {tab === "evolve" && (
            <section className="evolution-strip">
              <div>
                <span className="eyebrow">ADAPTATION LOG</span>
                <h3>
                  {epoch
                    ? `${epoch} epochs of possibility.`
                    : "Let the rules find their way."}
                </h3>
                <p>
                  Elitist search · fixed seed ·{" "}
                  {objective === "longevity"
                    ? "bounded, finite lifetime"
                    : objective}{" "}
                  fitness
                </p>
              </div>
              <div className="fitness-chart">
                {fitnessHistory.length > 1 ? (
                  <PopulationChart
                    values={fitnessHistory}
                    progress={1}
                    evolution
                  />
                ) : (
                  <span>Run evolution to trace the best fitness.</span>
                )}
              </div>
              <button
                className="text-button"
                onClick={() => {
                  resetEvolution();
                  setNotice(
                    "Evolution history cleared. Current rule retained.",
                  );
                }}
                aria-label="Clear evolution history"
              >
                <RotateCcw size={15} />
              </button>
            </section>
          )}
          <section className="collection" aria-label="Specimen collection">
            <div className="collection-heading">
              <div>
                <span className="eyebrow">THE STARTING COLLECTION</span>
                <span className="collection-subtitle">
                  Three rules. Very different lives.
                </span>
              </div>
              <div className="file-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  aria-label="Import specimen file"
                  className="visually-hidden"
                  onChange={(event) =>
                    void importSpecimen(event.target.files?.[0])
                  }
                />
                <button
                  onClick={() => fileInput.current?.click()}
                  title="Import a saved specimen"
                >
                  <Upload size={13} />
                  <span>Import</span>
                </button>
                <button onClick={exportSpecimen}>
                  <ArrowDownToLine size={13} />
                  <span>Save specimen</span>
                </button>
              </div>
            </div>
            <div className="specimen-grid">
              {PRESETS.map((preset, index) => (
                <button
                  key={preset.id}
                  className={`specimen-card ${selectedPreset === preset.id ? "selected" : ""}`}
                  onClick={() => selectPreset(index)}
                  aria-label={`Select ${preset.name} specimen`}
                  aria-pressed={selectedPreset === preset.id}
                >
                  <SpecimenPreview preset={preset} />
                  <div className="specimen-info">
                    <span>0{index + 1} / STUDY</span>
                    <strong>{preset.name}</strong>
                    <small>{preset.subtitle}</small>
                  </div>
                  <span className="specimen-arrow">
                    {selectedPreset === preset.id ? (
                      <Check size={15} />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </main>
      <footer className="site-footer">
        <span>
          POLYP OBSERVER <i /> A FIELD GUIDE TO EMERGENT BEHAVIOR
        </span>
        <button onClick={() => setAboutOpen(true)}>
          Inspired by Stephen Wolfram's studies of adaptive evolution{" "}
          <ArrowUpRight size={12} />
        </button>
        <span>2 SPACE + 1 TIME</span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <RuleEditor
        open={ruleOpen}
        genome={genome}
        onClose={() => setRuleOpen(false)}
        onApply={(value) => {
          resetEvolution();
          setGenome(value);
          setName("Custom form");
          setSelectedPreset("");
          setNotice("Custom rule applied.");
        }}
      />
      <dialog
        ref={dialogRef}
        onKeyDown={trapDialogTab}
        aria-labelledby="model-title"
        onCancel={() => setAboutOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setAboutOpen(false);
        }}
        className="about-dialog"
      >
        <div className="dialog-content">
          <button
            className="dialog-close"
            aria-label="Close model explanation"
            onClick={() => setAboutOpen(false)}
          >
            <X size={19} />
          </button>
          <div className="eyebrow">A FIELD NOTE / THE MODEL</div>
          <h2 id="model-title">
            Life as a<br />
            <em>computation.</em>
          </h2>
          <p>
            What if an organism is a rule, and its body is everything that rule
            does?
          </p>
          <p>
            Inspired by Stephen Wolfram's 2024 writing on adaptive evolution,
            Polyp treats a cellular automaton's rule as its genotype and its
            unfolding pattern as its phenotype.
          </p>
          <div className="model-facts">
            <div>
              <strong>Two dimensions of space</strong>
              <span>
                A square lattice. Five states (0 is empty). Each cell reads its
                eight Moore neighbors. A 45-gene lookup maps its current state
                and occupied-neighbor count to its next state.
              </span>
            </div>
            <div>
              <strong>One dimension of time</strong>
              <span>
                Every horizontal slice is a generation, starting at t = 0 on the
                floor. Layers stack upward to make a spacetime sculpture—not a
                spatial 3D automaton. Click the form or scrub the timeline to
                inspect its past.
              </span>
            </div>
            <div>
              <strong>Rules that evolve</strong>
              <span>
                A seeded genetic search uses selection, crossover, mutation and
                elitism. This is a five-state, two-dimensional adaptation, not a
                reproduction of Wolfram's one-dimensional model.
                Finite-longevity scores are bounded by the simulation window,
                not proofs of eventual extinction.
              </span>
            </div>
          </div>
          <a
            href="https://writings.stephenwolfram.com/2024/05/why-does-biological-evolution-work-a-minimal-model-for-biological-evolution-and-other-adaptive-processes/"
            target="_blank"
            rel="noreferrer"
            className="paper-link"
          >
            Read the original essay <ArrowUpRight size={16} />
          </a>
          <div className="dialog-bottom">
            <CircleHelp size={15} /> Drag to orbit. Scroll to zoom. Space to
            play time.
            <br />
            Your current specimen stays in this browser. Export to keep a copy.
          </div>
        </div>
      </dialog>
    </div>
  );
}
