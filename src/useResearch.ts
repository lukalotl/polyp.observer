import { useCallback, useEffect, useRef, useState } from "react";
import { post, request } from "./research/api";
import type {
  Capacity,
  ResearchEvent,
  RunAction,
  RunCheckpoint,
  RunConfig,
  RunDetail,
  RunList,
  RunSummary,
} from "./research/types";

const EMPTY_CAPACITY: Capacity = {
  maxRuns: 0,
  maxEvaluationWorkers: 0,
  allocatedWorkers: 0,
};
const SELECTED_KEY = "polyp.research.selected";
function rememberedRun() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function newerSummary(previous: RunSummary, incoming: RunSummary): boolean {
  if (incoming.updatedAt !== previous.updatedAt)
    return incoming.updatedAt > previous.updatedAt;
  return incoming.generation >= previous.generation;
}
export function mergeRunDetail(
  previous: RunDetail | null,
  incoming: RunDetail,
): RunDetail {
  return previous &&
    previous.summary.id === incoming.summary.id &&
    !newerSummary(previous.summary, incoming.summary)
    ? previous
    : incoming;
}

/** Observer connection only: disconnecting this hook never pauses a research run. */
export function useResearch() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [capacity, setCapacity] = useState(EMPTY_CAPACITY);
  const [modelVersion, setModelVersion] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(rememberedRun);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const selected = useRef(selectedId);
  const mounted = useRef(false);
  const connected = useRef(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const knownRuns = useRef<RunSummary[]>([]);
  const operationPending = useRef(false);
  const reconnectNow = useRef<() => void>(() => {});

  const select = useCallback((id: string | null) => {
    selected.current = id;
    ++detailRequest.current;
    setSelectedId(id);
    setDetail(null);
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* Optional preference. */
    }
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: "subscribe", runId: id }));
  }, []);

  const acceptList = useCallback(
    (list: RunList) => {
      if (!mounted.current) return;
      ++listRequest.current;
      // Runs are archived, not removed; union protects a just-created row from an
      // older in-flight registry response. Per-run timestamps prevent regression.
      const merged = new Map(knownRuns.current.map((run) => [run.id, run]));
      for (const run of list.runs) {
        const previous = merged.get(run.id);
        if (!previous || newerSummary(previous, run)) merged.set(run.id, run);
      }
      const values = [...merged.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      knownRuns.current = values;
      setRuns(values);
      setCapacity(list.capacity);
      setModelVersion(list.modelVersion);
      setLoading(false);
      if (
        !selected.current ||
        !values.some((run) => run.id === selected.current)
      ) {
        select(values.find((run) => run.status !== "archived")?.id ?? null);
      }
    },
    [select],
  );

  const refresh = useCallback(async () => {
    const revision = ++listRequest.current;
    try {
      const value = await request<RunList>("/api/runs");
      if (revision === listRequest.current) acceptList(value);
    } catch (caught) {
      if (mounted.current) {
        setLoading(false);
        setConnectionError(
          caught instanceof Error
            ? caught.message
            : "Research service unavailable.",
        );
      }
    }
  }, [acceptList]);

  const acceptDetail = useCallback((value: RunDetail) => {
    if (!mounted.current) return;
    ++listRequest.current;
    const previous = knownRuns.current.find(
      (run) => run.id === value.summary.id,
    );
    const summary =
      previous && !newerSummary(previous, value.summary)
        ? previous
        : value.summary;
    const values = [
      summary,
      ...knownRuns.current.filter((run) => run.id !== summary.id),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    knownRuns.current = values;
    setRuns(values);
    if (selected.current === value.summary.id) {
      ++detailRequest.current;
      setDetail((previous) => mergeRunDetail(previous, value));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    void refresh();
    const connect = () => {
      if (disposed) return;
      clearTimeout(reconnectTimer);
      const previous = socket.current;
      if (previous) {
        previous.onclose = null;
        previous.onerror = null;
        previous.onmessage = null;
        previous.close();
      }
      socket.current = null;
      connected.current = false;
      setConnection(attempts ? "reconnecting" : "connecting");
      let transport: WebSocket;
      const disconnected = () => {
        if (disposed || socket.current !== transport) return;
        transport.onclose = null;
        transport.onerror = null;
        transport.onmessage = null;
        socket.current = null;
        transport.close();
        connected.current = false;
        setConnection("reconnecting");
        setConnectionError(
          "Live connection interrupted. VM runs are unaffected.",
        );
        reconnectTimer = setTimeout(
          connect,
          Math.min(15_000, 750 * 2 ** Math.min(attempts++, 5)),
        );
      };
      try {
        const url = new URL("/api/research/ws", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        transport = new WebSocket(url);
        socket.current = transport;
      } catch {
        if (!disposed) {
          setConnection("reconnecting");
          setConnectionError(
            "Live connection unavailable. VM runs are unaffected.",
          );
          reconnectTimer = setTimeout(connect, 3000);
        }
        return;
      }
      transport.onopen = () => {
        if (disposed || socket.current !== transport) return;
        transport.send(
          JSON.stringify({ type: "subscribe", runId: selected.current }),
        );
      };
      transport.onmessage = (event) => {
        if (disposed || socket.current !== transport) return;
        try {
          const message = JSON.parse(String(event.data)) as ResearchEvent;
          if (message.type === "hello") {
            attempts = 0;
            connected.current = true;
            setConnection("connected");
            setConnectionError("");
            setCapacity(message.capacity);
            setModelVersion(message.modelVersion);
          } else if (message.type === "runs") {
            acceptList(message);
          } else if (
            message.type === "run" &&
            message.runId === message.detail.summary.id
          ) {
            acceptDetail(message.detail);
          } else if (message.type === "error") setError(message.error);
        } catch {
          setConnectionError("Invalid live update from research service.");
        }
      };
      transport.onerror = disconnected;
      transport.onclose = disconnected;
    };
    reconnectNow.current = connect;
    connect();
    const poll = setInterval(() => {
      void refresh();
      const id = selected.current;
      if (!connected.current && id) {
        const revision = ++detailRequest.current;
        void request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`)
          .then((value) => {
            if (
              !disposed &&
              selected.current === id &&
              revision === detailRequest.current
            )
              setDetail((previous) => mergeRunDetail(previous, value));
          })
          .catch(() => {});
      }
    }, 5000);
    return () => {
      disposed = true;
      mounted.current = false;
      connected.current = false;
      ++detailRequest.current;
      ++listRequest.current;
      clearInterval(poll);
      clearTimeout(reconnectTimer);
      const transport = socket.current;
      socket.current = null;
      if (transport) {
        transport.onclose = null;
        transport.onerror = null;
        transport.onmessage = null;
        transport.close();
      }
    };
  }, [acceptList, acceptDetail, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const revision = ++detailRequest.current;
    void request<RunDetail>(`/api/runs/${encodeURIComponent(selectedId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (
          !controller.signal.aborted &&
          selected.current === selectedId &&
          revision === detailRequest.current
        )
          setDetail((previous) => mergeRunDetail(previous, value));
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : "Could not load run.",
          );
      });
    return () => controller.abort();
  }, [selectedId]);

  const operate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      if (operationPending.current)
        throw new Error("A run operation is already pending.");
      operationPending.current = true;
      setBusy(true);
      setError("");
      try {
        return await operation();
      } catch (caught) {
        if (mounted.current)
          setError(
            caught instanceof Error ? caught.message : "Operation failed.",
          );
        throw caught;
      } finally {
        operationPending.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  const action = useCallback(
    (id: string, action: RunAction) =>
      operate(async () => {
        const value = await post<RunDetail>(
          `/api/runs/${encodeURIComponent(id)}/actions`,
          { action },
        );
        acceptDetail(value);
        return value;
      }),
    [acceptDetail, operate],
  );

  const create = useCallback(
    (config: RunConfig, start = false) =>
      operate(async () => {
        const value = await post<RunDetail>("/api/runs", { config, start });
        acceptDetail(value);
        select(value.summary.id);
        setDetail(value);
        return value;
      }),
    [acceptDetail, operate, select],
  );

  const fork = useCallback(
    (id: string) =>
      operate(async () => {
        const value = await post<RunDetail>(
          `/api/runs/${encodeURIComponent(id)}/fork`,
          { start: false },
        );
        acceptDetail(value);
        select(value.summary.id);
        setDetail(value);
        return value;
      }),
    [acceptDetail, operate, select],
  );

  const importCheckpoint = useCallback(
    (checkpoint: RunCheckpoint) =>
      operate(async () => {
        const value = await post<RunDetail>("/api/runs/import", {
          checkpoint,
          start: false,
        });
        acceptDetail(value);
        select(value.summary.id);
        setDetail(value);
        return value;
      }),
    [acceptDetail, operate, select],
  );

  return {
    runs,
    capacity,
    modelVersion,
    selectedId,
    detail,
    connection,
    connectionError,
    error,
    loading,
    busy,
    select,
    refresh,
    action,
    create,
    fork,
    importCheckpoint,
    clearError: () => setError(""),
    reconnect: () => reconnectNow.current(),
  };
}
