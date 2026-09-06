# Polyp Observer

**An observatory for artificial life.** A browser-based cellular-automata studio:
two dimensions of space, with their history stacked into the third dimension.

Polyp was rebuilt around a deterministic **five-state 2D model**, real genetic
search, and a tactile 3D viewport. The visual direction combines a paper-toned
interface with a dark scientific stage, faceted voxels, ordered dithering and
film grain. All computation and storage stay in the browser; no account, API key,
analytics service, backend, or runtime asset CDN is required.

## Run

Requires Node.js 22+ and npm.

```sh
npm ci
npm run dev       # Vite, binds 0.0.0.0; default port 5173
npm test          # deterministic engine, renderer, file-format and UI tests
npm run build     # TypeScript + production bundle in dist/
npm run preview   # serve the production bundle
```

For real-browser tests:

```sh
npx playwright install chromium
npm run test:e2e
```

The Playwright configuration starts a Vite server if one is not already running.
Static deployment needs only the contents of `dist/`. There are no server routes.

## Explore

- **Drag** to orbit; **scroll/pinch** to zoom; right-drag to pan.
- **Play time** or press **Space** to reveal the recorded history.
- Scrub the timeline, or click an occupied voxel/point to cut the volume at its
  generation. Layer `0` is the seed. The latest layer is `steps - 1`.
- Pick **Dendrite**, **Pagoda**, or **Archipelago** as a starting specimen.
- Change the point/cross/islands seed, world size, or recorded time depth.
- **Mutate this rule** changes one or more rule outputs. Click the genotype strip
  to inspect and edit all 45 outputs directly; the quiescent gene is locked.
- Switch between voxels/points and mineral/ember/ink palettes, toggle the actual
  dither shader, enable slow orbit, reset the camera, or expand the stage.
- In **Evolution**, choose a fitness objective and run/pause a seeded genetic
  search. Work happens in a Web Worker, not on the UI thread. Configuration
  changes cancel a run; playback is disabled while rules are evolving.
- **Save specimen** exports a versioned JSON file containing the complete rule,
  seed, dimensions, and horizon. **Import** validates and restores it. The current
  specimen also persists in local storage when available.

## What is being simulated?

A synchronous five-state **outer-totalistic Moore-neighborhood** automaton. Each
cell counts its eight occupied neighbors and reads the next state from:

```ts
nextState = genome[currentState * 9 + occupiedNeighborCount];
```

State `0` is void; states `1–4` are occupied. A genome has 45 outputs. `genome[0]`
is always `0`, so empty space is absorbing. The finite lattice has fixed-zero
boundaries, not toroidal wrapping. Each `Uint8Array` layer is a 2D generation;
the vertical rendering axis is **time**, not a third spatial neighborhood.

Curated rules cycle through the four occupied states before clearing, subject to
neighbor-count restrictions. Edited/evolved rules need not retain those age-like
semantics. The default cross-seeded Dendrite uses 5,427 occupied spacetime voxels
across 48 layers in a 41×41 field.

### Evolution, not an animation of evolution

Each epoch evaluates an eight-member population over three breeding rounds:
two elites, tournament selection, uniform crossover, and independent point
mutation. All candidates share exactly the same seed and environment. Equal-best
rules can be accepted for neutral drift; the best fitness never decreases within
an unchanged experiment.

The objectives are deliberately explicit:

- **Complexity**: a visual heuristic combining occupied-state entropy, activity,
  moderate density, population variation, and persistence—not algorithmic
  complexity or biological fitness.
- **Finite longevity**: rewards longer _observed finite_ lifetimes. A pattern
  still alive at the horizon scores zero. A finite observation window cannot
  prove immortality, and the boundary can affect extinction.
- **Growth**: rewards net final expansion and occupancy; dense forms are allowed.

Exact formulas, seed definitions, genetic-search details, scientific caveats and
preset regression measurements are documented in
[`src/simulation/README.md`](src/simulation/README.md).

### Relationship to Wolfram

Inspired by Stephen Wolfram's [_Why Does Biological Evolution Work? A Minimal
Model for Biological Evolution and Other Adaptive Processes_ (May 2024)](https://writings.stephenwolfram.com/2024/05/why-does-biological-evolution-work-a-minimal-model-for-biological-evolution-and-other-adaptive-processes/).
His one-dimensional minimal model connects a rule (genotype) with its evolving
pattern (phenotype). **This project is a five-state, two-dimensional adaptation,
not a reproduction of that essay's encoding, experimental protocol, or results.**
The 45-gene encoding and visual objectives are design choices for this studio.

## Architecture

- `src/simulation/`: dependency-free deterministic engine and genetic search.
- `src/evolution.worker.ts`: isolated evolutionary evaluation.
- `src/rendering/`: immutable instance packing, palettes/shaders, stage geometry.
- `src/components/Volume.tsx`: demand-rendered Three.js/R3F viewport; orbit and
  orthographic framing, instance-count time slicing, and WebGL failure handling.
- `src/components/RuleEditor.tsx`: accessible draft/apply genotype editor.
- `src/experiment.ts`: versioned specimen validation and optional local storage.
- `src/App.tsx`: experiment controls, lifecycle, playback and import/export.
- `e2e/`: real-browser user-path tests.

The renderer packs occupied instances only when the simulation changes. Scrubbing
changes the draw count rather than rebuilding geometry. Materials use actual
4×4 Bayer quantization and deterministic screen-space noise; a subtle decorative
surface grain also sits over the stage. DPR is capped at 1.5, idle views use a
demand frame loop, and reduced-motion preferences disable automatic orbit.

## License and assets

Project: GNU GPL v3.0; see [LICENSE](LICENSE). The self-hosted DM Sans, IBM Plex
Mono and Instrument Serif fonts are distributed under the SIL Open Font License;
license files are included in `public/fonts/`. Specimen previews, technical-stage
textures, geometry and shader effects are generated by the application.
