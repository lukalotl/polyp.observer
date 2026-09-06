import { useMemo, useState } from "react";
import type {
  GenerationSnapshot,
  Individual,
  ParentRef,
} from "../../research/types";
import {
  alleleFrequencies,
  formatFitness,
  geneLabel,
  traceGene,
} from "./visualizerData";
import "./visualizers.css";

export interface GeneticsViewProps {
  individual: Individual | null;
  snapshot: GenerationSnapshot | null;
}
function GenomeRow({
  label,
  genome,
  individual,
}: {
  label: string;
  genome: number[];
  individual?: Individual;
}) {
  return (
    <div className="rv-ancestry-row">
      <span className="rv-row-label">{label}</span>
      <div className="rv-gene-strip">
        {genome.map((output, locus) => {
          const trace = individual ? traceGene(individual, locus) : null;
          const detail = trace?.parent
            ? `; source P${trace.source! + 1} ${trace.parent.id}, ${trace.before} → ${trace.after}${trace.mutated ? "; mutated" : ""}`
            : "";
          return (
            <span
              key={locus}
              className={`rv-gene rv-state-${output}${locus === 0 ? " rv-quiescent" : ""}${trace?.mutated ? " rv-mutated" : ""}${locus % 9 === 0 ? " rv-gene-group" : ""}`}
              title={geneLabel(locus, output) + detail}
              aria-label={geneLabel(locus, output) + detail}
            >
              {output}
            </span>
          );
        })}
      </div>
    </div>
  );
}
function Parent({
  parent,
  index,
  statistics,
}: {
  parent: ParentRef;
  index: number;
  statistics: boolean;
}) {
  return (
    <div className="rv-parent">
      <div className="rv-parent-meta">
        <span className={`rv-parent-tag rv-source-${index}`}>P{index + 1}</span>
        <span className="rv-id" title={parent.id}>
          {parent.id}
        </span>
        {statistics && (
          <span className="rv-muted">
            born {parent.birthGeneration} · fitness{" "}
            {formatFitness(parent.fitness)}
          </span>
        )}
      </div>
      <GenomeRow label={`Parent ${index + 1}`} genome={parent.genome} />
    </div>
  );
}
export default function GeneticsView({
  individual,
  snapshot,
}: GeneticsViewProps) {
  const [statistics, setStatistics] = useState(true);
  const [frequencies, setFrequencies] = useState(false);
  const alleles = useMemo(
    () => alleleFrequencies(snapshot?.population ?? []),
    [snapshot],
  );
  if (!individual)
    return (
      <div className="rv-empty">
        Select an individual to inspect its rule and recorded parents.
      </div>
    );
  return (
    <section
      className="rv-panel rv-genetics"
      aria-label="Genetics and immediate ancestry"
    >
      <div className="rv-toolbar">
        <span className="rv-id" title={individual.id}>
          {individual.id}{" "}
          <span className="rv-muted">/ {individual.origin}</span>
        </span>
        <label className="rv-check">
          <input
            type="checkbox"
            checked={statistics}
            onChange={(event) => setStatistics(event.target.checked)}
          />
          Statistics
        </label>
      </div>
      <div className="rv-genetics-scroll">
        {statistics && (
          <div className="rv-statline">
            <span>
              Fitness <b>{formatFitness(individual.fitness)}</b>
            </span>
            <span>
              Held-out <b>{formatFitness(individual.validationFitness)}</b>
            </span>
            <span>
              Born <b>{individual.birthGeneration}</b>
            </span>
            <span>
              Mutated loci <b>{individual.mutatedLoci.length}</b>
            </span>
          </div>
        )}
        <h3 className="rv-section-label">Recorded parents → offspring</h3>
        <div className="rv-ancestry">
          {individual.parents.length ? (
            individual.parents.map((parent, index) => (
              <Parent
                key={`${parent.id}-${index}`}
                parent={parent}
                index={index}
                statistics={statistics}
              />
            ))
          ) : (
            <div className="rv-ancestry-note">
              {individual.origin === "immigrant"
                ? "Immigrant — independently generated; no parents."
                : individual.origin === "founder" ||
                    individual.origin === "random"
                  ? "Founder — independently initialized; no parents."
                  : "No parents recorded for this individual."}
            </div>
          )}
          {individual.parents.length > 0 && (
            <div className="rv-ancestry-link">
              <span aria-hidden="true">↓</span>
              <span>
                Recorded source per locus, before mutation · immediate ancestry
                only
              </span>
            </div>
          )}
          {individual.parents.length > 0 && (
            <div className="rv-ancestry-row">
              <span className="rv-row-label">Source</span>
              <div className="rv-gene-strip">
                {individual.genome.map((_, locus) => {
                  const trace = traceGene(individual, locus);
                  return (
                    <span
                      key={locus}
                      className={`rv-source-cell rv-source-${trace.source}${locus % 9 === 0 ? " rv-gene-group" : ""}`}
                      title={
                        trace.parent
                          ? `Locus ${locus}: P${trace.source! + 1} ${trace.parent.id}; inherited ${trace.before}${trace.mutated ? `, mutated to ${trace.after}` : ""}`
                          : `Locus ${locus}: no parent source recorded`
                      }
                    >
                      {trace.source === null ? "—" : trace.source + 1}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          <GenomeRow
            label="Offspring"
            genome={individual.genome}
            individual={individual}
          />
        </div>
        <div className="rv-legend">
          <span>
            <i className="rv-gene rv-state-2 rv-mutated" />
            mutation event
          </span>
          <span>
            <i className="rv-gene rv-state-0 rv-quiescent" />
            fixed quiescent locus
          </span>
        </div>
        <h3 className="rv-section-label">Selected rule · output state</h3>
        <div className="rv-matrix-wrap">
          <table
            className="rv-rule-matrix"
            aria-label="Selected rule: current state by active Moore neighbors"
          >
            <thead>
              <tr>
                <th scope="col">State / neighbors</th>
                {Array.from({ length: 9 }, (_, neighbors) => (
                  <th scope="col" key={neighbors}>
                    {neighbors}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4].map((state) => (
                <tr key={state}>
                  <th scope="row">
                    {state}
                    {state === 0 ? " · empty" : ""}
                  </th>
                  {Array.from({ length: 9 }, (_, neighbors) => {
                    const locus = state * 9 + neighbors;
                    const output = individual.genome[locus];
                    const trace = traceGene(individual, locus);
                    return (
                      <td key={neighbors} title={geneLabel(locus, output)}>
                        <span
                          className={`rv-gene rv-state-${output}${locus === 0 ? " rv-quiescent" : ""}${trace.mutated ? " rv-mutated" : ""}`}
                        >
                          {output}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rv-note">
          Each locus maps a cell’s current state and count of active Moore
          neighbors to its next state. State 0 is empty; (0, 0) stays 0.
        </p>
        {statistics && (
          <>
            <label className="rv-check rv-frequency-toggle">
              <input
                type="checkbox"
                checked={frequencies}
                onChange={(event) => setFrequencies(event.target.checked)}
              />
              Population allele frequencies
            </label>
            {frequencies &&
              (snapshot?.population.length ? (
                <div className="rv-frequency-wrap">
                  <div className="rv-muted rv-note">
                    Generation {snapshot.generation} · fraction of{" "}
                    {snapshot.population.length} genomes with each output at
                    each locus. Columns sum to 100%.
                  </div>
                  <div
                    className="rv-frequencies"
                    role="img"
                    aria-label="Allele frequencies for each of 45 loci and five output states"
                  >
                    {alleles.map((row, state) => (
                      <div className="rv-ancestry-row" key={state}>
                        <span className="rv-row-label">Output {state}</span>
                        <div className="rv-gene-strip">
                          {row.map((fraction, locus) => (
                            <span
                              key={locus}
                              className={`rv-frequency-cell rv-state-${state}${locus % 9 === 0 ? " rv-gene-group" : ""}`}
                              style={{ opacity: 0.12 + fraction * 0.88 }}
                              title={`${geneLabel(locus, state)}: ${(fraction * 100).toFixed(1)}% (${Math.round(fraction * snapshot.population.length)}/${snapshot.population.length})`}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="rv-note">
                  No population available for allele frequencies.
                </p>
              ))}
          </>
        )}
      </div>
    </section>
  );
}
