import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { GenerationSnapshot, Individual } from "../../research/types";
import { formatFitness, geneLabel, rankPopulation } from "./visualizerData";
import "./visualizers.css";

const PAGE_SIZE = 32;
export interface PopulationViewProps {
  snapshot: GenerationSnapshot | null;
  selectedId: string | null;
  onSelect: (individual: Individual) => void;
}
export default function PopulationView({
  snapshot,
  selectedId,
  onSelect,
}: PopulationViewProps) {
  const ranked = useMemo(
    () => rankPopulation(snapshot?.population ?? []),
    [snapshot],
  );
  const [page, setPage] = useState(0);
  const paging = useRef({ selectedId, manualPage: false });
  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  // Manual browsing survives live snapshots; a new selected identity resumes auto-paging.
  useEffect(() => {
    if (paging.current.selectedId !== selectedId) {
      paging.current = { selectedId, manualPage: false };
    }
    const index = ranked.findIndex(
      (individual) => individual.id === selectedId,
    );
    if (!paging.current.manualPage && index >= 0)
      setPage(Math.floor(index / PAGE_SIZE));
    else setPage((previous) => Math.min(previous, pages - 1));
  }, [ranked, selectedId, pages]);
  const changePage = (next: number) => {
    paging.current.manualPage = true;
    setPage(next);
  };
  if (!snapshot || !ranked.length)
    return (
      <div className="rv-empty">
        No evaluated population. Step or start a run to evaluate generation 0.
      </div>
    );
  const start = currentPage * PAGE_SIZE;
  const geneCount = ranked[0].genome.length;
  const stateCount = geneCount / 9;
  return (
    <section
      className="rv-panel rv-population"
      aria-label="Ranked population"
      style={
        {
          "--gene-count": geneCount,
          "--state-count": stateCount,
        } as CSSProperties
      }
    >
      <div className="rv-toolbar">
        <span className="rv-muted">
          Generation {snapshot.generation} · {ranked.length} individuals ·
          fitness descending
        </span>
        <div className="rv-pagination">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => changePage(currentPage - 1)}
            aria-label="Previous population page"
          >
            Previous
          </button>
          <span aria-live="polite">
            {start + 1}–{Math.min(start + PAGE_SIZE, ranked.length)} /{" "}
            {ranked.length}
          </span>
          <button
            type="button"
            disabled={currentPage >= pages - 1}
            onClick={() => changePage(currentPage + 1)}
            aria-label="Next population page"
          >
            Next
          </button>
        </div>
      </div>
      <div className="rv-table-scroll">
        <table
          className="rv-population-table"
          aria-label="Population ranked by training fitness"
        >
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Individual</th>
              <th scope="col" title="Aggregated training-seed fitness">
                Fitness
              </th>
              <th
                scope="col"
                title="Held-out validation-seed fitness; a dash means not evaluated"
              >
                Held-out
              </th>
              <th
                scope="col"
                title="Generation in which this individual was born"
              >
                Born
              </th>
              <th scope="col">Origin</th>
              <th scope="col" className="rv-genome-column">
                <span>Rule outputs · current state / active neighbors 0–8</span>
                <div className="rv-state-header" aria-hidden="true">
                  {Array.from({ length: stateCount }, (_, state) => state).map(
                    (state) => (
                      <span key={state}>s{state}</span>
                    ),
                  )}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.slice(start, start + PAGE_SIZE).map((individual, index) => (
              <tr
                key={individual.id}
                aria-selected={individual.id === selectedId}
                tabIndex={0}
                onClick={() => onSelect(individual)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(individual);
                  }
                }}
                aria-label={`Rank ${start + index + 1}, individual ${individual.id}, fitness ${formatFitness(individual.fitness)}`}
              >
                <td className="rv-muted">{start + index + 1}</td>
                <td className="rv-id" title={individual.id}>
                  {individual.id}
                </td>
                <td title={String(individual.fitness)}>
                  {formatFitness(individual.fitness)}
                </td>
                <td
                  title={
                    individual.validationFitness === null
                      ? "Not evaluated"
                      : String(individual.validationFitness)
                  }
                >
                  {formatFitness(individual.validationFitness)}
                </td>
                <td>{individual.birthGeneration}</td>
                <td
                  className="rv-muted"
                  title={
                    individual.parents.length
                      ? `Parents: ${individual.parents.map((parent) => parent.id).join(", ")}`
                      : "No parents recorded"
                  }
                >
                  {individual.origin}
                </td>
                <td>
                  <div
                    className="rv-gene-strip"
                    aria-label={`${geneCount} rule outputs`}
                  >
                    {individual.genome.map((output, locus) => (
                      <span
                        key={locus}
                        className={`rv-gene rv-state-${output}${locus === 0 ? " rv-quiescent" : ""}${locus % 9 === 0 ? " rv-gene-group" : ""}`}
                        title={geneLabel(locus, output)}
                        aria-label={geneLabel(locus, output)}
                      />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rv-legend">
        <span>Output</span>
        {Array.from({ length: stateCount }, (_, state) => state).map(
          (state) => (
            <span key={state}>
              <i className={`rv-gene rv-state-${state}`} />
              {state}
              {state === 0 ? " empty" : ""}
            </span>
          ),
        )}
        <span>
          <i className="rv-gene rv-state-0 rv-quiescent" />
          fixed quiescent locus
        </span>
      </div>
    </section>
  );
}
