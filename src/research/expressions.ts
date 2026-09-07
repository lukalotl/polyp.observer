/** A bounded math interpreter. Source never reaches JavaScript eval/Function. */
export const VARIABLES = [
  ["diversity", "Occupied-state entropy, 0–1; zero for binary rules"],
  ["activity", "Changes relative to occupancy, clamped to 0–1"],
  ["density", "Intermediate-density heuristic, 0–1"],
  ["variation", "Population standard deviation / mean, clamped to 0–1"],
  ["persistence", "Lifetime / steps, 0–1"],
  ["occupancy", "Total cells / (area × steps), 0–1"],
  [
    "exposedCells",
    "Distinct X/Z positions ever occupied; each time-column counts once, including trails after extinction",
  ],
  [
    "reusedCells",
    "Distinct X/Z positions repopulated after dying; each position counts once",
  ],
  [
    "reuseEvents",
    "Every empty-to-live return to a previously occupied X/Z position; repeated returns count again",
  ],
  [
    "cellDeaths",
    "Every live-to-empty transition; changing between live states is not a death",
  ],
  ["lifetime", "Number of nonempty timesteps, including the seed"],
  ["extinct", "1 if empty at the cutoff, otherwise 0"],
  ["initialPopulation", "Occupied cells in the starting configuration"],
  ["finalPopulation", "Occupied cells at the cutoff"],
  ["peakPopulation", "Largest occupied population at any timestep"],
  [
    "totalCells",
    "Sum of occupied cells across all timesteps, including the seed",
  ],
  ["meanPopulation", "Total cells / steps, including empty trailing timesteps"],
  ["populationVariance", "Population variance across all timesteps"],
  ["spatialContact", "1 if any occupied cell reaches an X/Z edge, otherwise 0"],
  ["cutoffContact", "1 if occupied at the final timestep, otherwise 0"],
  ["size", "Grid width and depth in cells"],
  ["area", "Grid size × grid size"],
  ["steps", "Number of timesteps, including the seed"],
  ["stateCount", "Number of states, including empty state 0"],
] as const;
export type Variable = (typeof VARIABLES)[number][0];
export type Measurements = Record<Variable, number>;
type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: Variable }
  | { kind: "unary"; op: string; child: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

const functions: Record<
  string,
  { min: number; max: number; run: (...args: number[]) => number }
> = {
  abs: { min: 1, max: 1, run: Math.abs },
  sqrt: { min: 1, max: 1, run: Math.sqrt },
  log: { min: 1, max: 1, run: Math.log },
  exp: { min: 1, max: 1, run: Math.exp },
  floor: { min: 1, max: 1, run: Math.floor },
  ceil: { min: 1, max: 1, run: Math.ceil },
  round: { min: 1, max: 1, run: Math.round },
  min: { min: 2, max: 8, run: Math.min },
  max: { min: 2, max: 8, run: Math.max },
  pow: { min: 2, max: 2, run: Math.pow },
  clamp: {
    min: 1,
    max: 3,
    run: (x, low = 0, high = 1) => Math.max(low, Math.min(high, x)),
  },
  if: { min: 3, max: 3, run: (condition, yes, no) => (condition ? yes : no) },
};
export const MATH_HELP =
  "+ − * / % ^ (or **) · < <= > >= == != · abs, sqrt, log, exp, floor, ceil, round · min/max (2–8 values), pow(x, y), clamp(x) or clamp(x, low, high), if(condition, yes, no) · constants pi, e";
const precedence: Record<string, number> = {
  "==": 1,
  "!=": 1,
  "<": 2,
  "<=": 2,
  ">": 2,
  ">=": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "%": 4,
  "^": 6,
  "**": 6,
};
const variableNames = new Set<string>(VARIABLES.map(([name]) => name));
const cache = new Map<string, (values: Measurements) => number>();

/** Syntax/arity/name validation is independent of any particular fixture. */
export function compileExpression(
  source: string,
): (values: Measurements) => number {
  if (typeof source !== "string" || !source.trim() || source.length > 512)
    throw new RangeError("Formula must contain 1–512 characters.");
  const cached = cache.get(source);
  if (cached) return cached;
  let position = 0,
    token = "",
    nodes = 0;
  const fail = (message: string): never => {
    throw new RangeError(`${message} Near character ${Math.max(1, position)}.`);
  };
  function next() {
    while (/\s/.test(source[position] ?? "") && position < source.length)
      position++;
    if (position === source.length) {
      token = "";
      return;
    }
    const match =
      /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z_0-9]*|\*\*|<=|>=|==|!=|[+\-*/%^(),<>])/.exec(
        source.slice(position),
      );
    if (!match) fail("Unsupported character");
    token = match![0];
    position += token.length;
  }
  function node(value: Node): Node {
    if (++nodes > 128)
      fail("Formula is too complex (maximum 128 operations/values)");
    return value;
  }
  function expression(min = 0, depth = 0): Node {
    if (depth > 24) fail("Formula is nested too deeply (maximum 24)");
    const first = token;
    let left: Node;
    next();
    if (first === "+" || first === "-") {
      left = node({
        kind: "unary",
        op: first,
        child: expression(5, depth + 1),
      });
    } else if (first === "(") {
      left = expression(0, depth + 1);
      if ((token as string) !== ")") fail("Expected closing parenthesis");
      next();
    } else if (/^(?:\d|\.)/.test(first)) {
      const value = Number(first);
      if (!Number.isFinite(value)) fail("Numbers must be finite");
      left = node({ kind: "number", value });
    } else if (token === "(" && Object.hasOwn(functions, first)) {
      next();
      const args: Node[] = [];
      if ((token as string) !== ")") {
        for (;;) {
          args.push(expression(0, depth + 1));
          if ((token as string) !== ",") break;
          next();
        }
      }
      if ((token as string) !== ")") fail("Expected closing parenthesis");
      const spec = functions[first];
      if (
        args.length < spec.min ||
        args.length > spec.max ||
        (first === "clamp" && args.length === 2)
      )
        fail(`Wrong number of arguments for ${first}`);
      next();
      left = node({ kind: "call", name: first, args });
    } else if (variableNames.has(first)) {
      left = node({ kind: "variable", name: first as Variable });
    } else if (first === "pi" || first === "e") {
      left = node({ kind: "number", value: first === "pi" ? Math.PI : Math.E });
    } else
      fail(
        first ? `Unknown variable or function “${first}”` : "Expected a value",
      );
    while (Object.hasOwn(precedence, token) && precedence[token] >= min) {
      const op = token,
        power = precedence[op];
      next();
      const right = expression(power + (power === 6 ? 0 : 1), depth + 1);
      left = node({ kind: "binary", op, left: left!, right });
    }
    return left!;
  }
  next();
  const root = expression();
  if (token) fail(`Unexpected token “${token}”`);
  function evaluate(ast: Node, values: Measurements): number {
    let result: number;
    switch (ast.kind) {
      case "number":
        return ast.value;
      case "variable":
        result = values[ast.name];
        break;
      case "unary":
        result = (ast.op === "-" ? -1 : 1) * evaluate(ast.child, values);
        break;
      case "call":
        // Conditional branches are lazy, so if(x > 0, 1/x, 0) is well-defined.
        result =
          ast.name === "if"
            ? evaluate(ast.args[evaluate(ast.args[0], values) ? 1 : 2], values)
            : functions[ast.name].run(
                ...ast.args.map((arg) => evaluate(arg, values)),
              );
        break;
      case "binary": {
        const a = evaluate(ast.left, values),
          b = evaluate(ast.right, values);
        switch (ast.op) {
          case "+":
            result = a + b;
            break;
          case "-":
            result = a - b;
            break;
          case "*":
            result = a * b;
            break;
          case "/":
            result = a / b;
            break;
          case "%":
            result = a % b;
            break;
          case "^":
          case "**":
            result = a ** b;
            break;
          case "<":
            result = Number(a < b);
            break;
          case "<=":
            result = Number(a <= b);
            break;
          case ">":
            result = Number(a > b);
            break;
          case ">=":
            result = Number(a >= b);
            break;
          case "==":
            result = Number(a === b);
            break;
          case "!=":
            result = Number(a !== b);
            break;
          default:
            throw new RangeError("Unknown operator.");
        }
        break;
      }
    }
    if (!Number.isFinite(result))
      throw new RangeError("Formula produced a non-finite value.");
    return result;
  }
  const compiled = (values: Measurements) => evaluate(root, values);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(source, compiled);
  return compiled;
}
