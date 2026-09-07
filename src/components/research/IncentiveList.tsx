import { useEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import {
  compileExpression,
  MATH_HELP,
  VARIABLES,
} from "../../research/expressions";
import {
  INCENTIVE_PRESETS,
  presetIncentive,
  type Incentive,
} from "../../research/incentives";
import { trapDialogTab } from "../../dialogFocus";

function IncentiveEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: Incentive | null;
  onSave: (incentive: Incentive) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formula = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [expression, setExpression] = useState(initial?.expression ?? "");
  useEffect(() => {
    const modal = ref.current;
    modal?.showModal();
    return () => {
      modal?.close();
    };
  }, []);
  let error = "";
  try {
    compileExpression(expression);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Invalid formula.";
  }
  function insertVariable(variable: string) {
    const input = formula.current;
    const start = input?.selectionStart ?? expression.length;
    const end = input?.selectionEnd ?? start;
    setExpression(
      expression.slice(0, start) + variable + expression.slice(end),
    );
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(
        start + variable.length,
        start + variable.length,
      );
    });
  }
  return (
    <dialog
      ref={ref}
      className="run-dialog incentive-dialog"
      aria-labelledby="incentive-title"
      onKeyDown={(event) => {
        event.stopPropagation();
        trapDialogTab(event);
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id="incentive-title">
          {initial ? "Edit incentive" : "New incentive"}
        </h2>
        <button aria-label="Close incentive editor" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="run-dialog-content">
        <h3 className="incentive-section-label">Available variables</h3>
        <p className="config-note">
          Measured separately for each starting configuration. Click a variable
          to insert it.
        </p>
        <dl className="measurement-list">
          {VARIABLES.map(([variable, description]) => (
            <div key={variable}>
              <dt>
                <button onClick={() => insertVariable(variable)}>
                  {variable}
                </button>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
        <label className="config-field">
          <span>Name</span>
          <input
            autoFocus
            aria-label="Incentive name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="incentive-formula-label" htmlFor="incentive-formula">
          Math formula
        </label>
        <textarea
          ref={formula}
          id="incentive-formula"
          aria-describedby="formula-help formula-status"
          aria-invalid={!!expression && !!error}
          spellCheck={false}
          maxLength={512}
          rows={3}
          placeholder="extinct * (1 - occupancy)"
          value={expression}
          onChange={(event) => setExpression(event.target.value)}
        />
        <p className="config-note" id="formula-help">
          {MATH_HELP}
        </p>
        <p
          className={error && expression ? "inline-error" : "config-note"}
          id="formula-status"
          role="status"
        >
          {expression
            ? error || "Valid formula"
            : "Enter a formula using the variables above."}
        </p>
        <p className="config-note">
          Each result is clamped to 0–1 before weighting. Normalize cell counts
          with area or area * steps. Invalid arithmetic (such as division by
          zero) gives this incentive zero for that fixture. if() evaluates only
          the chosen branch.
        </p>
      </div>
      <footer className="dialog-footer">
        <span>Formulas support only the math operations listed above.</span>
        <div className="button-row">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary-action"
            disabled={!name.trim() || !!error}
            onClick={() => {
              onSave({
                name: name.trim(),
                expression: expression.trim(),
                weight: initial?.weight ?? 1,
              });
              onClose();
            }}
          >
            {initial ? "Save incentive" : "Add incentive"}
          </button>
        </div>
      </footer>
    </dialog>
  );
}

export default function IncentiveList({
  value,
  onChange,
}: {
  value: Incentive[];
  onChange: (value: Incentive[]) => void;
}) {
  const [editor, setEditor] = useState<number | "new" | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  function openEditor(which: number | "new", trigger: HTMLElement) {
    returnFocus.current = trigger;
    setEditor(which);
  }
  function closeEditor() {
    setEditor(null);
    requestAnimationFrame(() => returnFocus.current?.focus());
  }
  const total = value.reduce(
    (sum, item) =>
      sum + (Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 0),
    0,
  );
  return (
    <>
      <label className="config-field incentive-picker">
        <span>Add incentive</span>
        <select
          aria-label="Add incentive"
          value=""
          disabled={value.length >= 16}
          onChange={(event) => {
            if (event.target.value === "new")
              openEditor("new", event.currentTarget);
            else if (event.target.value)
              onChange([...value, presetIncentive(event.target.value)]);
          }}
        >
          <option value="new">+ New incentive…</option>
          <option value="" disabled hidden>
            Choose a preset or create one…
          </option>
          <optgroup label="Premade incentives">
            {INCENTIVE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <ol className="incentive-list" aria-label="Scoring incentives">
        {value.map((item, index) => (
          <li key={index}>
            <div className="incentive-details">
              <strong>{item.name}</strong>
              <code>{item.expression}</code>
              {INCENTIVE_PRESETS.find(
                (preset) => preset.expression === item.expression,
              )?.description && (
                <small>
                  {
                    INCENTIVE_PRESETS.find(
                      (preset) => preset.expression === item.expression,
                    )!.description
                  }
                </small>
              )}
            </div>
            <label className="incentive-weight">
              <span>Weight</span>
              <input
                aria-label={`Incentive ${index + 1} weight`}
                type="number"
                min={0}
                max={10000}
                step="any"
                value={Number.isFinite(item.weight) ? item.weight : ""}
                onChange={(event) =>
                  onChange(
                    value.map((entry, i) =>
                      i === index
                        ? { ...entry, weight: event.target.valueAsNumber }
                        : entry,
                    ),
                  )
                }
              />
              <output>
                {total > 0 && Number.isFinite(item.weight) && item.weight >= 0
                  ? `${((100 * item.weight) / total).toFixed(1)}%`
                  : "—"}
              </output>
            </label>
            <div className="incentive-actions">
              <button
                aria-label={`Edit incentive ${index + 1}: ${item.name}`}
                onClick={(event) => openEditor(index, event.currentTarget)}
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`Remove incentive ${index + 1}: ${item.name}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      {!value.length && (
        <p className="config-note">
          Add an incentive to define what this experiment rewards.
        </p>
      )}
      <p className="config-note">
        Fixture score = Σ(weight × clamp(formula, 0, 1)) / Σ(weight). Weights
        set relative shares; zero disables an incentive. Add up to 16
        incentives, with at least one positive weight. Finite presets score zero
        for themselves when a fixture survives; other incentives can still
        contribute.
      </p>
      {editor !== null && (
        <IncentiveEditor
          initial={editor === "new" ? null : value[editor]}
          onClose={closeEditor}
          onSave={(item) =>
            onChange(
              editor === "new"
                ? [...value, item]
                : value.map((entry, index) =>
                    index === editor ? item : entry,
                  ),
            )
          }
        />
      )}
    </>
  );
}
