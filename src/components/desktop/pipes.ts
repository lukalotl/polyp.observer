const DX = [0, 1, 0, -1],
  DY = [-1, 0, 1, 0];
const BIT = [1, 2, 4, 8];
export const PIPE_GLYPHS = [
  " ",
  "╹",
  "╺",
  "┗",
  "╻",
  "┃",
  "┏",
  "┣",
  "╸",
  "┛",
  "━",
  "┻",
  "┓",
  "┫",
  "┳",
  "╋",
];

/** Bounded, seeded terminal decoration. Its state is independent of the CA engine. */
export class PipeField {
  cells: Uint8Array;
  colors: Uint8Array;
  private rng: number;
  private age = 0;
  private walkers: {
    x: number;
    y: number;
    direction: number;
    remaining: number;
    color: number;
  }[];
  constructor(
    public width: number,
    public height: number,
    seed: number,
  ) {
    this.rng = seed || 1;
    this.cells = new Uint8Array(width * height);
    this.colors = new Uint8Array(width * height);
    this.walkers = Array.from({ length: 12 }, (_, color) => ({
      x: this.random(width),
      y: this.random(height),
      direction: this.random(4),
      remaining: 2 + this.random(9),
      color: color % 5,
    }));
    this.advance(Math.floor((width * height) / 10));
  }
  private random(limit: number) {
    this.rng ^= this.rng << 13;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    return (this.rng >>> 0) % limit;
  }
  advance(steps = 1) {
    for (let step = 0; step < steps; step++) {
      // Begin a new drawing before the walkers run out of empty cells.
      if (++this.age > Math.max(80, (this.width * this.height) / 3)) {
        this.cells.fill(0);
        this.age = 0;
        // Fill the start of the next pattern in this frame, avoiding an empty flash.
        steps += Math.floor((this.width * this.height) / 10);
      }
      for (const walker of this.walkers) {
        if (--walker.remaining <= 0) {
          walker.direction = (walker.direction + (this.random(2) ? 1 : 3)) % 4;
          walker.remaining = 2 + this.random(11);
        }
        const x = walker.x + DX[walker.direction],
          y = walker.y + DY[walker.direction];
        if (
          x < 0 ||
          y < 0 ||
          x >= this.width ||
          y >= this.height ||
          this.cells[y * this.width + x]
        ) {
          walker.direction = (walker.direction + 1) % 4;
          walker.remaining = 1;
          if (this.random(7) === 0) {
            walker.x = this.random(this.width);
            walker.y = this.random(this.height);
          }
          continue;
        }
        const from = walker.y * this.width + walker.x,
          to = y * this.width + x;
        this.cells[from] |= BIT[walker.direction];
        this.cells[to] |= BIT[(walker.direction + 2) % 4];
        this.colors[from] = this.colors[to] = walker.color;
        walker.x = x;
        walker.y = y;
      }
    }
  }
}
