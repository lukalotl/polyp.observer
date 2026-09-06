/** Internal, pure genetic operators. Inputs are validated at the public boundary. */
export function uniformCrossover(
  first: readonly number[],
  second: readonly number[],
  random: () => number,
): number[] {
  return first.map((gene, index) =>
    index === 0 ? 0 : random() < 0.5 ? second[index] : gene,
  );
}

/** Three draws with replacement; ties preserve the first selected contestant. */
export function tournamentSelect<T extends { fitness: number }>(
  population: readonly T[],
  random: () => number,
): T {
  let winner = population[Math.floor(random() * population.length)];
  for (let entrant = 1; entrant < 3; entrant++) {
    const challenger = population[Math.floor(random() * population.length)];
    if (challenger.fitness > winner.fitness) winner = challenger;
  }
  return winner;
}
