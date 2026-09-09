import { scoreIncentives } from "./incentives";
import type { Genome } from "../simulation";
import { validateGenome, validateRunConfig } from "./config";
import { isDisqualified } from "./boundaries";
import { streamTrajectory } from "./trajectory";
import type { Evaluation, FitnessMetrics, RunConfig } from "./types";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const metricKeys: (keyof FitnessMetrics)[] = [
  "diversity",
  "activity",
  "density",
  "variation",
  "persistence",
  "occupancy",
  "lifetime",
  "extinctFraction",
];

/** Scoring and preview share the same full-horizon streaming trajectory. */
function fixture(
  genome: Genome,
  config: RunConfig,
  seed: number,
): { score: number; metrics: FitnessMetrics; disqualified: boolean } {
  const { size, steps } = config;
  const area = size * size;
  const simulation = streamTrajectory(genome, config, seed);
  const { population, occupancy, lifetime, diversity } = simulation;
  const persistence = lifetime / steps;
  const activity = clamp(simulation.activity / Math.max(occupancy, 0.01));
  const mean = occupancy * area;
  // Same ordered sum as legacy, not E[x²]-E[x]² (which loses precision).
  const variance =
    population.reduce((sum, count) => sum + (count - mean) ** 2, 0) / steps;
  const variation = clamp(Math.sqrt(variance) / Math.max(1, mean));
  const density =
    clamp(occupancy / 0.1) * clamp(1 - Math.max(0, occupancy - 0.25) / 0.55);
  const final = population[steps - 1],
    extinct = final === 0;
  const metrics: FitnessMetrics = {
    diversity,
    activity,
    density,
    variation,
    persistence,
    occupancy,
    lifetime,
    extinctFraction: extinct ? 1 : 0,
  };
  let score: number;
  if (config.incentives) {
    const contacts = simulation.boundaryContacts;
    score = scoreIncentives(config.incentives, {
      diversity,
      activity,
      density,
      variation,
      persistence,
      occupancy,
      lifetime,
      extinct: Number(extinct),
      initialPopulation: population[0],
      finalPopulation: final,
      peakPopulation: population.reduce(
        (peak, count) => Math.max(peak, count),
        0,
      ),
      totalCells: population.reduce((sum, count) => sum + count, 0),
      exposedCells: simulation.exposedCells,
      reusedCells: simulation.reusedCells,
      reuseEvents: simulation.reuseEvents,
      reuseAlive: simulation.reuseAlive,
      cellDeaths: simulation.cellDeaths,
      meanPopulation: mean,
      populationVariance: variance,
      spatialContact: Number(
        [contacts.left, contacts.right, contacts.front, contacts.back].some(
          (time) => time !== null,
        ),
      ),
      cutoffContact: Number(contacts.horizon),
      size,
      area,
      steps,
      stateCount: config.stateCount,
    });
  } else if (config.objective === "longevity")
    score = extinct ? clamp(lifetime / Math.max(1, steps - 1)) : 0;
  else if (
    config.objective === "finiteSparse" ||
    config.objective === "finiteDense"
  )
    score =
      extinct && lifetime > 0
        ? clamp(config.objective === "finiteSparse" ? 1 - occupancy : occupancy)
        : 0;
  else if (config.objective === "growth") {
    const gain = clamp(
      (final - population[0]) / Math.max(1, area - population[0]),
    );
    score = clamp(0.65 * gain + 0.25 * occupancy + 0.1 * persistence);
  } else {
    const w = config.weights,
      total = w.diversity + w.activity + w.density + w.variation;
    // Normalize first, so even finite subnormal positive weights cannot lose
    // their entire weighted numerator to underflow. Default total is exactly 1.
    score = clamp(
      persistence *
        ((w.diversity / total) * diversity +
          (w.activity / total) * activity +
          (w.density / total) * density +
          (w.variation / total) * variation),
    );
  }
  const finiteCells =
    config.objective === "finiteSparse" || config.objective === "finiteDense";
  const disqualified =
    (!config.incentives && finiteCells && (!extinct || lifetime === 0)) ||
    isDisqualified(simulation.boundaryContacts, config.boundaryPolicy);
  return { score: disqualified ? 0 : score, metrics, disqualified };
}

function evaluateValid(genome: Genome, config: RunConfig): Evaluation {
  const training = config.trainingSeeds.map((seed) =>
    fixture(genome, config, seed),
  );
  const trainingScores = training.map((result) => result.score);
  const validation = config.validationSeeds.map((seed) =>
    fixture(genome, config, seed),
  );
  const validationScores = validation.map((result) => result.score);
  const disqualified = training.some((result) => result.disqualified);
  const validationDisqualified = validation.some(
    (result) => result.disqualified,
  );
  const aggregate = (scores: number[]) =>
    config.aggregation === "minimum"
      ? Math.min(...scores)
      : scores.reduce((a, b) => a + b, 0) / scores.length;
  const metrics = Object.fromEntries(
    metricKeys.map((key) => [
      key,
      training.reduce((sum, result) => sum + result.metrics[key], 0) /
        training.length,
    ]),
  ) as unknown as FitnessMetrics;
  return {
    ...(config.fixtureFailures === "aggregate"
      ? {
          fixturePasses: {
            training: training.map((result) => !result.disqualified),
            validation: validation.map((result) => !result.disqualified),
          },
        }
      : {}),
    fitness:
      disqualified && config.fixtureFailures !== "aggregate"
        ? 0
        : aggregate(trainingScores),
    disqualified,
    validationDisqualified,
    validationFitness: validationScores.length
      ? validationDisqualified && config.fixtureFailures !== "aggregate"
        ? 0
        : aggregate(validationScores)
      : null,
    trainingScores,
    validationScores,
    metrics,
  };
}

export function evaluateGenome(genome: Genome, config: RunConfig): Evaluation {
  const checked = validateRunConfig(config);
  return evaluateValid(validateGenome(genome, checked.stateCount), checked);
}
/** Inline reference implementation. Parallel executors must return INPUT order, not completion order. */
export async function evaluateBatch(
  genomes: Genome[],
  config: RunConfig,
): Promise<Evaluation[]> {
  const checked = validateRunConfig(config);
  if (!Array.isArray(genomes) || genomes.length > 512)
    throw new RangeError("Evaluation batch exceeds 512 candidates.");
  return Array.from(genomes, (genome) =>
    evaluateValid(validateGenome(genome, checked.stateCount), checked),
  );
}
