import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  GenerationSnapshot,
  HistoryPoint,
  Individual,
} from "../../research/types";
import PopulationView from "./PopulationView";
import GeneticsView from "./GeneticsView";
import HistoryView from "./HistoryView";

afterEach(cleanup);
function member(index: number): Individual {
  return {
    id: `i-${index}`,
    genome: Array.from({ length: 45 }, (_, locus) =>
      locus === 0 ? 0 : index % 5,
    ),
    fitness: 1 - index / 1000,
    validationFitness: index % 2 ? null : 0.5,
    birthGeneration: 0,
    origin: "founder",
    parents: [],
    crossoverMask: [],
    mutatedLoci: [],
    trainingScores: [],
    validationScores: [],
    metrics: {
      diversity: 0,
      activity: 0,
      density: 0,
      variation: 0,
      persistence: 0,
      occupancy: 0,
      lifetime: 0,
      extinctFraction: 0,
    },
  };
}
function historyPoint(
  generation: number,
  validationBest: number | null = null,
): HistoryPoint {
  return {
    generation,
    best: 0,
    bestEver: 0,
    mean: 0,
    worst: 0,
    median: 0,
    validationBest,
    diversity: 0,
    uniqueGenomes: 1,
    evaluations: 1,
    cacheHits: 0,
    elapsedMs: 0,
    generationMs: 0,
    evalsPerSecond: 0,
  };
}
function snapshot(count: number): GenerationSnapshot {
  const population = Array.from({ length: count }, (_, index) => member(index));
  return {
    generation: 2,
    population,
    champion: population[0],
    metrics: historyPoint(2),
  };
}

describe("population research panel", () => {
  it("bounds the DOM at 32 rows for a 512-member population, with stable ID keyboard selection", () => {
    const state = snapshot(512),
      onSelect = vi.fn();
    const { rerender } = render(
      <PopulationView snapshot={state} selectedId={null} onSelect={onSelect} />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(33);
    fireEvent.click(
      screen.getByRole("button", { name: "Next population page" }),
    );
    const selected = screen.getByRole("row", {
      name: /Rank 33, individual i-32,/,
    });
    fireEvent.keyDown(selected, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(state.population[32]);
    rerender(
      <PopulationView
        snapshot={state}
        selectedId="i-400"
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByRole("row", { name: /individual i-400,/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("row")).toHaveLength(33);
    expect(screen.getByText("385–416 / 512")).toBeInTheDocument();
  });
  it("preserves manual pages across live snapshots until the selected ID changes", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <PopulationView
        snapshot={snapshot(128)}
        selectedId="i-0"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Next population page" }),
    );
    rerender(
      <PopulationView
        snapshot={{ ...snapshot(128), generation: 3 }}
        selectedId="i-0"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("33–64 / 128")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Next population page" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Previous population page" }),
    );
    rerender(
      <PopulationView
        snapshot={{ ...snapshot(128), generation: 4 }}
        selectedId="i-0"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("33–64 / 128")).toBeInTheDocument();
    const updated = snapshot(128);
    rerender(
      <PopulationView
        snapshot={updated}
        selectedId="i-100"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("97–128 / 128")).toBeInTheDocument();
    expect(
      screen.getByRole("row", { name: /individual i-100,/ }),
    ).toHaveAttribute("aria-selected", "true");
    // Once selection changes, automatic tracking follows that identity's rank again.
    updated.population[100] = { ...updated.population[100], fitness: 2 };
    rerender(
      <PopulationView
        snapshot={{ ...updated, generation: 5 }}
        selectedId="i-100"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("1–32 / 128")).toBeInTheDocument();
  });
  it("keeps compact fitness text while exposing full-precision values in cell titles", () => {
    const state = snapshot(2);
    state.population[0] = {
      ...state.population[0],
      fitness: 0.999999987654321,
      validationFitness: 0.999999912345678,
    };
    render(
      <PopulationView snapshot={state} selectedId="i-0" onSelect={() => {}} />,
    );
    expect(screen.getByTitle("0.999999987654321")).toHaveTextContent("1.0000");
    expect(screen.getByTitle("0.999999912345678")).toHaveTextContent("1.0000");
    expect(screen.getByTitle("Not evaluated")).toHaveTextContent("—");
  });
  it("provides exact rule tooltips and a distinct fixed quiescent case", () => {
    render(
      <PopulationView
        snapshot={snapshot(1)}
        selectedId="i-0"
        onSelect={() => {}}
      />,
    );
    const quiescent = screen.getByLabelText(
      "Current state 0; 0 active neighbors → output 0 (quiescent, fixed)",
    );
    expect(quiescent).toHaveClass("rv-quiescent");
    expect(
      screen.getByLabelText("Current state 4; 8 active neighbors → output 0"),
    ).toHaveAttribute(
      "title",
      "Current state 4; 8 active neighbors → output 0",
    );
  });
});

describe("genetics research panel", () => {
  it("shows only supplied parents, exact mutation source, and hides all numeric statistics on request", () => {
    const state = snapshot(2),
      parent = state.population[1];
    const child = {
      ...member(3),
      id: "offspring",
      origin: "mutant" as const,
      parents: [parent],
      crossoverMask: Array(45).fill(0),
      mutatedLoci: [12],
    };
    child.genome = [...parent.genome];
    child.genome[12] = 4;
    render(<GeneticsView individual={child} snapshot={state} />);
    expect(screen.getByText("i-1")).toBeInTheDocument();
    expect(
      screen.getByTitle("Locus 12: P1 i-1; inherited 1, mutated to 4"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: /Selected rule/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Population allele frequencies" }),
    );
    expect(
      screen.getByRole("img", { name: /Allele frequencies/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Statistics" }));
    expect(screen.queryByText("Mutated loci")).not.toBeInTheDocument();
    expect(screen.queryByText(/born 0 · fitness/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /Allele frequencies/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: /Selected rule/ }),
    ).toBeInTheDocument();
  });
  it("marks immigrant ancestry as absent rather than inventing a lineage", () => {
    render(
      <GeneticsView
        individual={{ ...member(0), origin: "immigrant" }}
        snapshot={null}
      />,
    );
    expect(
      screen.getByText("Immigrant — independently generated; no parents."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
  });
});

describe("fitness history panel", () => {
  it("handles empty, single-point zero history and retained snapshot selection through controls", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <HistoryView
        history={[]}
        snapshots={[]}
        selectedGeneration={null}
        onSelectGeneration={onSelect}
      />,
    );
    expect(screen.getByText(/No fitness history/)).toBeInTheDocument();
    rerender(
      <HistoryView
        history={[historyPoint(0, 0)]}
        snapshots={[{ generation: 0, savedAt: "", bestFitness: 0 }]}
        selectedGeneration={null}
        onSelectGeneration={onSelect}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Fitness by GA generation/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/All 1 recorded history points shown/),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Retained generation" }),
      { target: { value: "0" } },
    );
    expect(onSelect).toHaveBeenLastCalledWith(0);
    rerender(
      <HistoryView
        history={[historyPoint(0)]}
        snapshots={[{ generation: 0, savedAt: "", bestFitness: 0 }]}
        selectedGeneration={0}
        onSelectGeneration={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
  it("breaks null held-out intervals, uses actual GA spacing, and supports chart keyboard inspection", () => {
    const history = [
      historyPoint(0, 0.2),
      historyPoint(2, 0.3),
      historyPoint(20, null),
      historyPoint(21, 0.4),
      historyPoint(22, 0.5),
    ];
    const onSelect = vi.fn();
    const { container } = render(
      <HistoryView
        history={history}
        snapshots={[
          { generation: 0, savedAt: "", bestFitness: 0 },
          { generation: 20, savedAt: "", bestFitness: 0 },
        ]}
        selectedGeneration={null}
        onSelectGeneration={onSelect}
      />,
    );
    const heldoutLines = container.querySelectorAll(
      '[data-series="validationBest"] polyline',
    );
    expect(heldoutLines).toHaveLength(2);
    const bestPoints = container
      .querySelector('[data-series="best"] polyline')!
      .getAttribute("points")!
      .split(" ")
      .map((pair) => Number(pair.split(",")[0]));
    expect(
      (bestPoints[2] - bestPoints[1]) / (bestPoints[1] - bestPoints[0]),
    ).toBeCloseTo(9, 2);
    const chart = screen.getByRole("img", { name: /Fitness by GA generation/ });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(20);
    fireEvent.click(screen.getByRole("checkbox", { name: "Held-out best" }));
    expect(
      container.querySelector('[data-series="validationBest"]'),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("combobox", { name: "Retained generation" }),
      ).getAllByRole("option"),
    ).toHaveLength(3);
  });
});
