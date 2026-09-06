# CA evolution

Minimal development environment for five-state, 2D cellular automata with time
rendered as the third dimension.

## Run

Node 20.19+ (22 recommended).

```sh
npm ci
npm run dev          # Vite :5173 + VM backend :8787, both watched
npm run build        # client + Node server/worker bundles
npm start            # production HTTP/WebSocket server :4173
```

`npm run preview` also starts the full Node server. Static-only hosting is not
sufficient. `PORT` overrides the production port; `API_PORT` and `CLIENT_PORT`
override development ports.

## Execution

The browser does **not** run the simulation or genetic search. It connects to
`/api/evolution` over WebSocket. The VM creates a real Node `worker_threads`
worker for that connection. The worker performs all candidate simulations,
fitness evaluation, selection, crossover, mutation, and neutral drift, then sends
the winning rule and base64-encoded time layers back for rendering.

- **Run / Pause**: continuous evolutionary search; **Step**: one search epoch.
- One epoch is three breeding rounds of eight candidates, with two elites.
- **Controls**: objective, mutation rate, reproducible seeds, lattice and rendering.
- **Diagnostics**: optional real worker thread ID, epoch, fitness and metrics.
- **Rule**: edit the 45 output entries. Void remains quiescent.
- The timeline, reference grid and all diagnostic stats can be hidden.
- JSON import/export retains the current rule and initial conditions.
- **Space** runs/pauses evolution; **.** steps; **Escape** closes a panel.

Each response echoes a client revision. Replaced work cannot overwrite a newer
configuration. Input changes pause a running search immediately and debounce
reevaluation. Closing or losing the connection terminates its worker; this is not
a persistent background-job service. Reconnect evaluates the last accepted rule.

`GET /api/health` reports actual live workers. Limits: four workers per server,
64 MiB old-generation heap per worker, supported lattice/horizon presets,
16 KiB commands, bounded command rate, compute timeout, snapshot backpressure,
and WebSocket heartbeat. This is a workspace dev server, not an authenticated
multi-tenant service; keep it behind a trusted workspace gateway or authentication
if exposed publicly. Same-origin checks reject cross-site browser connections.
The exact workspace forwarding origin is supported; other trusted proxies can
set `PUBLIC_ORIGIN` explicitly.

## Tests

```sh
npm test                    # engine, renderer, client lifecycle and import format
npm run test:server         # real TCP WebSockets + Node worker threads
npx playwright install chromium
npm run test:e2e            # browser + real VM backend
```

Playwright starts the combined dev environment if `/api/health` is unavailable.
CI runs all three suites and a production build.

## Model

`next = rule[currentState * 9 + occupiedMooreNeighbors]`

Five states; state 0 is empty; fixed-zero boundaries; 45 outputs. Finite-longevity
fitness is zero unless extinction occurs within the recorded horizon. Equal-best
genotypes may be accepted for neutral drift.

This is a 2D adaptation of Wolfram's adaptive-evolution model, not an exact paper
reproduction. Full encoding, fitness formulas and qualifications:
[`src/simulation/README.md`](src/simulation/README.md).

## Files

- `server/worker.ts`: simulation/search loop, executed only in a Node worker.
- `server/index.ts`: HTTP/WebSocket transport, worker lifetime and limits.
- `src/protocol.ts`: typed browser/VM messages.
- `src/useEvolution.ts`: connection lifecycle; no browser computation fallback.
- `src/simulation/`: deterministic cellular automaton and genetic algorithm.
- `src/components/Volume.tsx`, `src/rendering/`: instancing, camera and dither shader.

GPL-3.0; see [LICENSE](LICENSE).
