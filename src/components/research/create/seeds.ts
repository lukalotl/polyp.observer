/** Fresh, recorded search seeds: a new independent search never silently reuses 1729. */
const SEED_LIMIT = 2 ** 31;

export function freshSearchSeed(): number {
  const buffer = new Uint32Array(1);
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === "function")
    source.getRandomValues(buffer);
  else buffer[0] = Math.floor(Math.random() * 2 ** 32);
  return buffer[0] % SEED_LIMIT;
}

/** Distinct fresh seeds; the first entry is the caller's own seed. */
export function repeatSeeds(first: number, count: number): number[] {
  const seeds = [first];
  while (seeds.length < count) {
    const seed = freshSearchSeed();
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  return seeds;
}

export function parseSeeds(text: string, label: string): number[] {
  if (!text.trim()) return [];
  return text.split(",").map((value) => {
    if (!value.trim())
      throw new RangeError(`${label} must be comma-separated integers.`);
    const n = Number(value);
    if (!Number.isSafeInteger(n))
      throw new RangeError(`${label} must be safe integers.`);
    return n;
  });
}

/** Lenient count for live readouts while the user is still typing. */
export function listedSeeds(text: string): number[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value));
}

/** Worlds the evaluator actually distinguishes: the RNG folds seeds to uint32. */
export function distinctWorlds(seeds: number[]): number {
  return new Set(seeds.map((seed) => seed >>> 0)).size;
}
