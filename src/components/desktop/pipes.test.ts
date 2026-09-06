import { expect, it } from "vitest";
import { PipeField } from "./pipes";

it("keeps ASCII pipes connected, bounded and reproducible independently of research", () => {
  const first = new PipeField(35, 22, 1729),
    replay = new PipeField(35, 22, 1729);
  first.advance(30);
  replay.advance(30);
  expect(first.cells).toEqual(replay.cells);
  expect(first.colors).toEqual(replay.colors);
  expect(first.cells.length).toBe(770);
  expect(first.cells.some((value) => value !== 0)).toBe(true);
  for (let y = 0; y < first.height; y++)
    for (let x = 0; x < first.width; x++) {
      const value = first.cells[y * first.width + x];
      if (value & 1) {
        expect(y).toBeGreaterThan(0);
        expect(first.cells[(y - 1) * first.width + x] & 4).toBeTruthy();
      }
      if (value & 2) {
        expect(x).toBeLessThan(first.width - 1);
        expect(first.cells[y * first.width + x + 1] & 8).toBeTruthy();
      }
      if (value & 4) {
        expect(y).toBeLessThan(first.height - 1);
        expect(first.cells[(y + 1) * first.width + x] & 1).toBeTruthy();
      }
      if (value & 8) {
        expect(x).toBeGreaterThan(0);
        expect(first.cells[y * first.width + x - 1] & 2).toBeTruthy();
      }
    }
});

it("keeps drawing fresh patterns after a full cycle", () => {
  const field = new PipeField(35, 22, 1729);
  field.advance(230);
  const previous = field.cells.slice();
  field.advance(70);
  expect(field.cells).not.toEqual(previous);
  expect(field.cells.some((value) => value === 0)).toBe(true);
});

it("retains a dense visible pattern at every cycle boundary", () => {
  const field = new PipeField(35, 22, 1729);
  for (let frame = 0; frame < 600; frame++) {
    field.advance(2);
    expect(field.cells.filter((cell) => cell !== 0).length).toBeGreaterThan(77);
  }
});
