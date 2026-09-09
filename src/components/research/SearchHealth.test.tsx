import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { HistoryPoint } from "../../research/types";
import SearchHealth from "./SearchHealth";

afterEach(cleanup);
function point(extra: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    generation: 12,
    best: 0.5,
    bestEver: 0.6,
    mean: 0.3,
    worst: 0,
    median: 0.3,
    validationBest: null,
    diversity: 0.4,
    uniqueGenomes: 50,
    evaluations: 700,
    cacheHits: 60,
    distinctElites: 2,
    bestCopies: 3,
    generationsSinceImprovement: 12,
    elapsedMs: 0,
    generationMs: 0,
    evalsPerSecond: 0,
    ...extra,
  };
}
const items = () => {
  const region = screen.getByRole("region", { name: "Search health" });
  return {
    region,
    text: (label: string) =>
      within(region)
        .getByText(label, { exact: false })
        .closest(".rv-health-item")!.textContent,
  };
};

describe("search health strip", () => {
  it("shows every signal with its denominator and an explanatory title when all fields are present", () => {
    render(
      <SearchHealth
        latest={point({ generationEvaluations: 58, generationRepeats: 6 })}
        eliteCount={4}
        populationSize={64}
      />,
    );
    const { region, text } = items();
    expect(text("Since improvement")).toBe("Since improvement 12 gen");
    expect(text("Distinct among top 4")).toBe("Distinct among top 4 2 / 4");
    expect(text("Best copies")).toBe("Best copies 3 / 64");
    expect(text("Unique evaluations")).toBe("Unique evaluations 58");
    expect(text("Repeat share")).toBe("Repeat share 9.4%");
    for (const item of region.querySelectorAll(".rv-health-item"))
      expect(item.getAttribute("title")?.length ?? 0).toBeGreaterThan(20);
    expect(
      within(region).getByTitle(/repeats \/ \(repeats \+ unique evaluations\)/),
    ).toHaveTextContent("9.4%");
    // The head-convergence readout is labelled as such: distinct elitism keeps
    // retained elites distinct by construction, so the count is about copies of
    // the leader crowding the top ranks, not about the retained elites.
    const head = within(region).getByTitle(/the 4 fittest individuals/);
    expect(head).toHaveTextContent("Distinct among top 4 2 / 4");
    expect(head.getAttribute("title")).toMatch(/^Head convergence/);
    expect(head.getAttribute("title")).toMatch(/distinct by construction/);
    expect(head.getAttribute("title")).toMatch(/copies of the leader/);
    expect(within(region).queryByText(/Distinct elites/)).toBeNull();
    expect(region.querySelectorAll(".rv-health-unrecorded")).toHaveLength(0);
    expect(region.textContent).not.toContain("NaN");
  });
  it("reports unrecorded counts and bare counts when optional fields and denominators are absent", () => {
    render(<SearchHealth latest={point()} />);
    const { region, text } = items();
    expect(text("Distinct among top ranks")).toBe("Distinct among top ranks 2");
    expect(
      within(region).getByTitle(/top-ranked individuals \(one per elite slot\)/),
    ).toHaveTextContent("Distinct among top ranks 2");
    expect(text("Best copies")).toBe("Best copies 3");
    expect(text("Unique evaluations")).toBe("Unique evaluations not recorded");
    expect(text("Repeat share")).toBe("Repeat share not recorded");
    expect(region.querySelectorAll(".rv-health-unrecorded")).toHaveLength(2);
    expect(region.textContent).not.toContain("NaN");
    expect(region.textContent).not.toContain("/");
  });
  it("computes repeat share as repeats over all candidates, including the all-repeat and no-candidate edges", () => {
    const { rerender } = render(
      <SearchHealth
        latest={point({ generationEvaluations: 0, generationRepeats: 62 })}
      />,
    );
    expect(items().text("Repeat share")).toBe("Repeat share 100.0%");
    expect(items().text("Unique evaluations")).toBe("Unique evaluations 0");
    rerender(
      <SearchHealth
        latest={point({ generationEvaluations: 62, generationRepeats: 0 })}
      />,
    );
    expect(items().text("Repeat share")).toBe("Repeat share 0.0%");
    rerender(
      <SearchHealth
        latest={point({ generationEvaluations: 0, generationRepeats: 0 })}
      />,
    );
    expect(items().text("Repeat share")).toBe("Repeat share —");
    expect(items().region.textContent).not.toContain("NaN");
    // One count without the other is not a share.
    rerender(<SearchHealth latest={point({ generationEvaluations: 40 })} />);
    expect(items().text("Unique evaluations")).toBe("Unique evaluations 40");
    expect(items().text("Repeat share")).toBe("Repeat share not recorded");
  });
  it("renders placeholders rather than crashing without a history point or with legacy metrics", () => {
    const { rerender } = render(
      <SearchHealth latest={null} eliteCount={4} populationSize={64} />,
    );
    const { region, text } = items();
    expect(text("Since improvement")).toBe("Since improvement —");
    expect(text("Distinct among top 4")).toBe("Distinct among top 4 —");
    expect(text("Best copies")).toBe("Best copies —");
    expect(text("Unique evaluations")).toBe("Unique evaluations —");
    expect(text("Repeat share")).toBe("Repeat share —");
    expect(region.textContent).not.toContain("NaN");
    const legacy = point() as Partial<HistoryPoint>;
    delete legacy.distinctElites;
    delete legacy.bestCopies;
    delete legacy.generationsSinceImprovement;
    rerender(
      <SearchHealth latest={legacy as HistoryPoint} eliteCount={4} />,
    );
    expect(items().text("Since improvement")).toBe("Since improvement —");
    expect(items().text("Distinct among top 4")).toBe("Distinct among top 4 —");
    expect(items().text("Best copies")).toBe("Best copies —");
    expect(items().region.textContent).not.toContain("NaN");
  });
});
