import { useEffect, useRef, useState } from "react";
import { ArrowRight, LockKeyhole, X } from "lucide-react";
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
      onKeyDown={trapDialogTab}
      aria-labelledby="rule-title"
      className="about-dialog rule-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <button
          className="dialog-close"
          aria-label="Close rule editor"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        <div className="eyebrow">THE GENOTYPE / 45 POSSIBILITIES</div>
        <h2 id="rule-title">
          A rule for
          <br />
          <em>every encounter.</em>
        </h2>
        <p>
          Each cell reads its own state and counts its occupied neighbors. This
          table decides what it becomes.
        </p>
        <div className="rule-table-label">OCCUPIED NEIGHBORS →</div>
        <div className="rule-table">
          <span className="rule-table-corner">STATE ↓</span>
          {Array.from({ length: 9 }, (_, i) => (
            <span className="rule-table-heading" key={i}>
              {i}
            </span>
          ))}
          {Array.from({ length: 5 }, (_, state) => (
            <div className="rule-table-row" key={state}>
              <span className="rule-table-heading">{state}</span>
              {Array.from({ length: 9 }, (_, neighbors) => {
                const index = state * 9 + neighbors;
                return (
                  <button
                    key={index}
                    className={`rule-cell gene-${draft[index]}`}
                    disabled={index === 0}
                    aria-label={`State ${state}, ${neighbors} neighbors: next state ${draft[index]}`}
                    title={
                      index === 0
                        ? "Empty space stays empty."
                        : "Click to cycle the output state."
                    }
                    onClick={() =>
                      setDraft((values) =>
                        values.map((value, i) =>
                          i === index ? (value + 1) % 5 : value,
                        ),
                      )
                    }
                  >
                    {index === 0 ? <LockKeyhole size={12} /> : draft[index]}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="rule-table-hint">
          Click an output to cycle 0 → 1 → 2 → 3 → 4. The empty-neighborhood
          rule is locked at 0.
        </p>
        <button
          className="primary-button"
          onClick={() => {
            onApply(draft);
            onClose();
          }}
        >
          <span>Grow this rule</span>
          <ArrowRight size={16} />
        </button>
      </div>
    </dialog>
  );
}
