import { useEffect, useRef, useState } from "react";
import { LockKeyhole, X } from "lucide-react";
import type { Genome } from "../simulation";
import { trapDialogTab } from "../dialogFocus";

export default function RuleEditor({
  open,
  genome,
  onClose,
  onApply,
}: {
  open: boolean;
  genome: Genome;
  onClose: () => void;
  onApply: (genome: Genome) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(genome);
  useEffect(() => {
    if (open) {
      setDraft([...genome]);
      ref.current?.showModal();
    } else ref.current?.close();
  }, [open, genome]);
  return (
    <dialog
      ref={ref}
      className="rule-dialog"
      aria-labelledby="rule-title"
      onKeyDown={trapDialogTab}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id="rule-title">Rule</h2>
        <button aria-label="Close rule editor" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="rule-content">
        <div className="rule-table-label">Occupied neighbors</div>
        <div className="rule-table">
          <span className="rule-table-corner">State</span>
          {Array.from({ length: 9 }, (_, n) => (
            <span key={n} className="rule-table-heading">
              {n}
            </span>
          ))}
          {Array.from({ length: 5 }, (_, state) => (
            <div key={state} className="rule-table-row">
              <span className="rule-table-heading">{state}</span>
              {Array.from({ length: 9 }, (_, neighbors) => {
                const index = state * 9 + neighbors;
                return (
                  <button
                    key={index}
                    className={`rule-cell gene-${draft[index]}`}
                    disabled={index === 0}
                    title={index === 0 ? "Quiescent state" : "Cycle output"}
                    aria-label={`State ${state}, ${neighbors} neighbors: next state ${draft[index]}`}
                    onClick={() =>
                      setDraft((values) =>
                        values.map((value, i) =>
                          i === index ? (value + 1) % 5 : value,
                        ),
                      )
                    }
                  >
                    {index === 0 ? <LockKeyhole size={11} /> : draft[index]}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <code className="rule-help">next = rule[state × 9 + occupied]</code>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="apply-button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </dialog>
  );
}
