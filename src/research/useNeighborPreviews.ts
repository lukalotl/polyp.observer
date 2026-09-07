import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { decodePreview } from "./preview";
import type { Genome } from "../simulation";
import type { PreviewFrame, PreviewRange } from "./types";
import { MAX_PREVIEW_LAYER_BYTES } from "./sample";

export interface ModelPreview {
  simulation?: ReturnType<typeof decodePreview>;
  error?: string;
}

/** Visible specimens, fetched serially only after the inspected specimen.
 * One WebGL context and a byte/count bounded cache keep large populations cheap.
 * Context includes run, fixture and time range: previews never cross experiments.
 */
export function useNeighborPreviews({
  context,
  runId,
  genomes,
  seed,
  range,
  ready,
}: {
  context: string;
  runId?: string;
  genomes: Genome[];
  seed: number;
  range?: PreviewRange;
  ready: boolean;
}) {
  const cache = useRef(new Map<string, ModelPreview & { bytes: number }>());
  const [revision, refresh] = useState(0);
  const keys = genomes.map((genome) => genome.join(",")).join(";");
  useEffect(() => {
    cache.current.clear();
  }, [context]);
  useEffect(() => {
    if (!runId || !ready) return;
    const controller = new AbortController();
    const visibleKeys = new Set(
      genomes.map((genome) => `${context}:${genome.join(",")}`),
    );
    const trimCache = () => {
      let bytes = [...cache.current.values()].reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      );
      let changed = false;
      while (
        cache.current.size > visibleKeys.size + 1 ||
        bytes > MAX_PREVIEW_LAYER_BYTES * 2
      ) {
        // Visible models own their data; evict offscreen previews first. GPU
        // scenes unmount as soon as their slots leave the scroll viewport.
        const oldest = [...cache.current.keys()].find(
          (key) => !visibleKeys.has(key),
        );
        if (oldest === undefined) break;
        bytes -= cache.current.get(oldest)!.bytes;
        cache.current.delete(oldest);
        changed = true;
      }
      return changed;
    };
    if (trimCache()) refresh((value) => value + 1);
    const timer = setTimeout(() => {
      void (async () => {
        for (const genome of genomes) {
          if (controller.signal.aborted) return;
          const key = `${context}:${genome.join(",")}`;
          const cached = cache.current.get(key);
          if (cached) {
            cache.current.delete(key);
            cache.current.set(key, cached);
            continue;
          }
          let result: ModelPreview & { bytes: number };
          try {
            const frame = await request<PreviewFrame>(
              `/api/runs/${encodeURIComponent(runId)}/preview`,
              {
                method: "POST",
                body: JSON.stringify({ genome, seed, range }),
                signal: controller.signal,
              },
            );
            if (controller.signal.aborted) return;
            const simulation = decodePreview(frame);
            result = {
              simulation,
              bytes: simulation.layers.reduce(
                (sum, layer) => sum + layer.byteLength,
                0,
              ),
            };
          } catch (error) {
            if (controller.signal.aborted) return;
            result = {
              error:
                error instanceof Error ? error.message : "Preview unavailable",
              bytes: 0,
            };
          }
          cache.current.set(key, result);
          trimCache();
          refresh((value) => value + 1);
        }
      })();
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Genotypes, rather than live object identities, define this loading window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, keys, ready, runId]);
  void revision;
  return (genome: Genome): ModelPreview | undefined =>
    cache.current.get(`${context}:${genome.join(",")}`);
}
