import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Code2, SlidersHorizontal, X } from "lucide-react";
import { validateRunConfig } from "../../research/config";
import type { RunConfig } from "../../research/types";
import { trapDialogTab } from "../../dialogFocus";
import { incentivesForConfig } from "../../research/incentives";
import RuleEditor from "../RuleEditor";
import BudgetSection from "./create/BudgetSection";
import ExperimentSummary from "./create/ExperimentSummary";
import GoalSection from "./create/GoalSection";
import SearchSection from "./create/SearchSection";
import WorldsSection from "./create/WorldsSection";
import { locateError, type DraftApi } from "./create/draft";
import { listedSeeds, parseSeeds, repeatSeeds } from "./create/seeds";
import {
  experimentSummary,
  SECTIONS,
  type SectionId,
  type SummaryItem,
} from "./create/summary";

interface Props {
  initial: RunConfig;
  title?: string;
  maxWorkers: number;
  busy: boolean;
  /** The run this draft was copied from; enables an exact replay of its seed. */
  sourceSeed?: number;
  onClose: () => void;
  onCreate: (config: RunConfig, start: boolean) => Promise<unknown>;
}
interface FieldError {
  field: string;
  message: string;
}
const MAX_NAME = 80;

export default function RunDialog({
  initial,
  title = "New run",
  maxWorkers,
  busy,
  sourceSeed,
  onClose,
  onCreate,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nav = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<RunConfig>(() => ({
    ...structuredClone(initial),
    fixtureFailures: "aggregate",
    incentives: incentivesForConfig(initial),
  }));
  const [trainText, setTrainText] = useState(initial.trainingSeeds.join(", "));
  const [validationText, setValidationText] = useState(
    initial.validationSeeds.join(", "),
  );
  const [section, setSection] = useState<SectionId>("goal");
  const [repeats, setRepeats] = useState(1);
  const [raw, setRaw] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [editGenome, setEditGenome] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const api: DraftApi = {
    draft,
    update: (key, value) =>
      setDraft((current) => ({ ...current, [key]: value })),
    patch: (change) => setDraft((current) => change(current)),
    errorFor: (label) =>
      fieldError?.field === label ? fieldError.message : undefined,
  };
  const composed = () =>
    validateRunConfig(
      raw
        ? JSON.parse(json)
        : {
            ...draft,
            trainingSeeds: parseSeeds(trainText, "Training seeds"),
            validationSeeds: parseSeeds(validationText, "Held-out seeds"),
          },
    );
  function fail(caught: unknown, fallback: string) {
    const message = caught instanceof Error ? caught.message : fallback;
    setError(message);
    const located = raw ? null : locateError(message);
    setFieldError(located ? { field: located.field, message } : null);
    if (located?.section) setSection(located.section);
  }
  async function submit(start: boolean) {
    let config: RunConfig;
    try {
      config = composed();
    } catch (caught) {
      fail(caught, "Invalid configuration.");
      return;
    }
    setError("");
    setFieldError(null);
    const count = Number.isInteger(repeats) ? Math.min(8, Math.max(1, repeats)) : 1;
    const seeds = repeatSeeds(config.randomSeed, count);
    for (let k = 0; k < seeds.length; k++) {
      const suffix = ` · seed ${k + 1}`;
      const run: RunConfig =
        count > 1
          ? {
              ...config,
              name: `${config.name.slice(0, MAX_NAME - suffix.length)}${suffix}`,
              randomSeed: seeds[k],
            }
          : config;
      try {
        await onCreate(run, start);
      } catch (caught) {
        fail(caught, "Could not create run.");
        return;
      }
    }
    onClose();
  }
  function switchEditor() {
    try {
      const config = composed();
      setDraft(
        raw ? { ...config, incentives: incentivesForConfig(config) } : config,
      );
      setTrainText(config.trainingSeeds.join(", "));
      setValidationText(config.validationSeeds.join(", "));
      setJson(JSON.stringify(config, null, 2));
      setRaw((value) => !value);
      setError("");
      setFieldError(null);
    } catch (caught) {
      fail(caught, "Invalid configuration.");
    }
  }
  function navigateKeys(event: KeyboardEvent<HTMLElement>) {
    const index = SECTIONS.findIndex((value) => value.id === section);
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (index + 1) % SECTIONS.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (index + SECTIONS.length - 1) % SECTIONS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? SECTIONS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setSection(SECTIONS[next].id);
    nav.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [next]?.focus();
  }
  const training = listedSeeds(trainText);
  const validation = listedSeeds(validationText);
  let summary: SummaryItem[] = [];
  let summaryUnavailable: string | undefined;
  if (raw) {
    try {
      const config = validateRunConfig(JSON.parse(json));
      summary = experimentSummary(
        config,
        config.trainingSeeds,
        config.validationSeeds,
        repeats,
        maxWorkers,
      );
    } catch (caught) {
      summaryUnavailable = `The summary follows the JSON once it validates. ${
        caught instanceof Error ? caught.message : ""
      }`.trim();
    }
  } else
    summary = experimentSummary(
      draft,
      training,
      validation,
      repeats,
      maxWorkers,
    );
  const active = SECTIONS.find((value) => value.id === section)!;
  const errorSection = fieldError
    ? locateError(fieldError.message)?.section
    : null;
  return (
    <dialog
      ref={dialog}
      className="run-dialog run-creator"
      aria-labelledby="run-dialog-title"
      onKeyDown={trapDialogTab}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id="run-dialog-title">{title}</h2>
        <div className="button-row">
          <button
            onClick={switchEditor}
            disabled={busy}
            aria-label={
              raw ? "Use parameter fields" : "Edit configuration JSON"
            }
          >
            {raw ? <SlidersHorizontal size={14} /> : <Code2 size={14} />}
            <span>{raw ? "Fields" : "JSON"}</span>
          </button>
          <button
            aria-label="Close run configuration"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className={`run-dialog-content creator-body ${raw ? "raw" : ""}`}>
        {!raw && (
          <nav
            ref={nav}
            className="creator-nav"
            aria-label="Run configuration sections"
            onKeyDown={navigateKeys}
          >
            {SECTIONS.map((value) => (
              <button
                key={value.id}
                type="button"
                className={`creator-nav-${value.id}`}
                aria-current={section === value.id ? "true" : undefined}
                data-error={errorSection === value.id ? "true" : undefined}
                onClick={() => setSection(value.id)}
              >
                {value.label}
                <small aria-hidden="true">{value.hint}</small>
              </button>
            ))}
          </nav>
        )}
        <div className="creator-main">
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {raw ? (
            <textarea
              aria-label="Configuration JSON"
              className="config-json-editor"
              spellCheck={false}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
          ) : (
            <>
              <label
                className={`config-name ${api.errorFor("Run name") ? "has-error" : ""}`}
              >
                <span>Name</span>
                <input
                  autoFocus
                  aria-label="Run name"
                  value={draft.name}
                  maxLength={MAX_NAME}
                  aria-invalid={api.errorFor("Run name") ? true : undefined}
                  onChange={(event) => api.update("name", event.target.value)}
                />
              </label>
              <section
                className={`creator-section creator-section-${section}`}
                aria-labelledby="creator-section-title"
              >
                <header className="creator-section-header">
                  <h3 id="creator-section-title">{active.label}</h3>
                  <p>{active.description}</p>
                </header>
                {section === "goal" && <GoalSection api={api} />}
                {section === "worlds" && (
                  <WorldsSection
                    api={api}
                    trainText={trainText}
                    validationText={validationText}
                    onTrainText={setTrainText}
                    onValidationText={setValidationText}
                  />
                )}
                {section === "search" && (
                  <SearchSection
                    api={api}
                    sourceSeed={sourceSeed}
                    trainingSeedCount={training.length}
                    onEditGenome={() => setEditGenome(true)}
                  />
                )}
                {section === "budget" && (
                  <BudgetSection
                    api={api}
                    maxWorkers={maxWorkers}
                    repeats={repeats}
                    onRepeats={setRepeats}
                    fixtureCount={training.length + validation.length}
                  />
                )}
              </section>
            </>
          )}
        </div>
        <ExperimentSummary
          items={summary}
          unavailable={summaryUnavailable}
          onSelectSection={raw ? undefined : setSection}
        />
      </div>
      <footer className="dialog-footer">
        <span>
          Configurations are immutable. Branch to change the experiment.
        </span>
        <div className="button-row">
          <button disabled={busy} onClick={() => void submit(false)}>
            Create paused
          </button>
          <button
            className="primary-action"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            {busy ? "Creating…" : "Create & start"}
          </button>
        </div>
      </footer>
      <RuleEditor
        open={editGenome}
        genome={draft.seedGenome}
        onClose={() => setEditGenome(false)}
        onApply={(value) => api.update("seedGenome", value)}
      />
    </dialog>
  );
}
