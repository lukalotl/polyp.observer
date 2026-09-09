import {
  SECTIONS,
  summarySentence,
  type SectionId,
  type SummaryItem,
} from "./summary";

export default function ExperimentSummary({
  items,
  unavailable,
  onSelectSection,
}: {
  items: SummaryItem[];
  /** Shown instead of the sentence while JSON is not yet valid. */
  unavailable?: string;
  onSelectSection?: (section: SectionId) => void;
}) {
  return (
    <aside className="experiment-summary" aria-label="Experiment summary">
      <h3>Experiment summary</h3>
      {unavailable ? (
        <p className="summary-sentence summary-unavailable">{unavailable}</p>
      ) : (
        <p className="summary-sentence">{summarySentence(items)}</p>
      )}
      {!unavailable &&
        SECTIONS.map((section) => {
          const own = items.filter((item) => item.section === section.id);
          if (!own.length) return null;
          return (
            <div key={section.id} className={`summary-group ${section.id}`}>
              {onSelectSection ? (
                <button
                  type="button"
                  className="summary-group-title"
                  onClick={() => onSelectSection(section.id)}
                  aria-label={`Open ${section.label} section`}
                >
                  {section.label}
                </button>
              ) : (
                <h4 className="summary-group-title">{section.label}</h4>
              )}
              <dl>
                {own.map((item) => (
                  <div key={item.key}>
                    <dt>{item.label}</dt>
                    <dd>{item.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
    </aside>
  );
}
