import { useCallback, useEffect, useRef, useState } from "react";
import type { Experiment } from "./experiment";
import type {
  EvolutionCommand,
  EvolutionRequest,
  EvolutionResponse,
  Execution,
  WireSimulation,
} from "./protocol";
import type { Objective, Simulation } from "./simulation";

export interface SearchSettings {
  objective: Objective;
  mutationRate: number;
  randomSeed: number;
}
export type ConnectionState = "connecting" | "ready" | "disconnected";

export function decodeSimulation(wire: WireSimulation): Simulation {
  return {
    ...wire,
    layers: wire.layers.map((encoded) => {
      const binary = atob(encoded);
      const layer = new Uint8Array(binary.length);
      if (layer.length !== wire.size * wire.size)
        throw new Error("Invalid VM layer size.");
      for (let i = 0; i < binary.length; i++) layer[i] = binary.charCodeAt(i);
      return layer;
    }),
  };
}

/** The browser only renders snapshots. Simulation and search execute on the VM. */
export function useEvolution(initial: Experiment) {
  const [experiment, setExperiment] = useState(initial);
  const [settings, setSettings] = useState<SearchSettings>({
    objective: "complexity",
    mutationRate: 0.08,
    randomSeed: 1729,
  });
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [score, setScore] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [reconnectKey, setReconnectKey] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const revision = useRef(0);
  const activeRun = useRef(false);
  const reconfigureTimer = useRef<ReturnType<typeof setTimeout>>();
  const current = useRef({
    experiment: initial,
    settings,
    epoch: 0,
    cursor: settings.randomSeed,
  });

  const send = useCallback((type: EvolutionRequest["type"]) => {
    clearTimeout(reconfigureTimer.current);
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN)
      return false;
    const state = current.current;
    const command: EvolutionCommand = {
      type,
      id: ++revision.current,
      genome: state.experiment.genome,
      config: state.experiment.config,
      objective: state.settings.objective,
      mutationRate: state.settings.mutationRate,
      randomSeed: state.cursor,
      epoch: state.epoch,
    };
    try {
      socket.current.send(JSON.stringify(command));
      activeRun.current = type === "start";
      setError("");
      setPending(true);
      setRunning(type === "start");
      return true;
    } catch {
      ++revision.current;
      activeRun.current = false;
      setError("VM connection failed.");
      setRunning(false);
      setPending(false);
      setConnection("disconnected");
      ready.current = false;
      try {
        socket.current?.close();
      } catch {
        /* Transport already failed. */
      }
      return false;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let failed = false;
    let transport: WebSocket;
    ready.current = false;
    setConnection("connecting");
    setRunning(false);
    setPending(true);
    setError("");
    ++revision.current;
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      ++revision.current;
      ready.current = false;
      activeRun.current = false;
      clearTimeout(reconfigureTimer.current);
      setConnection("disconnected");
      setRunning(false);
      setPending(false);
      setError((previous) => previous || message);
    };
    try {
      const url = new URL("/api/evolution", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      transport = new WebSocket(url);
      socket.current = transport;
    } catch {
      fail("VM connection unavailable.");
      return;
    }
    transport.onmessage = (event) => {
      if (disposed || failed) return;
      try {
        const message = JSON.parse(event.data as string) as EvolutionResponse;
        if (message.type === "ready") {
          if (
            message.execution.kind !== "node:worker_threads" ||
            message.execution.threadId <= 0
          )
            throw new Error("Invalid VM worker.");
          ready.current = true;
          setExecution(message.execution);
          setConnection("ready");
          send("evaluate");
          return;
        }
        if (!ready.current) return;
        if (message.type === "error") {
          if (message.id !== undefined && message.id !== revision.current)
            return;
          activeRun.current = false;
          setError(message.error);
          setPending(false);
          setRunning(false);
          return;
        }
        if (message.id !== revision.current) return;
        if (message.type === "paused") {
          activeRun.current = false;
          setRunning(false);
          setPending(false);
          return;
        }
        if (message.type !== "snapshot") return;
        const decoded = decodeSimulation(message.simulation);
        const previousEpoch = current.current.epoch;
        const nextExperiment: Experiment = {
          ...current.current.experiment,
          genome: message.genome,
          config: message.config,
        };
        current.current.experiment = nextExperiment;
        current.current.epoch = message.epoch;
        current.current.cursor = message.randomSeed;
        setExperiment(nextExperiment);
        setSimulation(decoded);
        setExecution(message.execution);
        activeRun.current = message.running;
        setEpoch(message.epoch);
        setScore(message.fitness);
        setRunning(message.running);
        setPending(false);
        setHistory((values) =>
          message.epoch > previousEpoch
            ? [...values, message.fitness].slice(-256)
            : values.length
              ? values
              : [message.fitness],
        );
      } catch {
        fail("Invalid response from VM worker.");
        transport.close();
      }
    };
    transport.onerror = () => fail("VM connection failed.");
    transport.onclose = (event) => fail(event.reason || "VM disconnected.");
    return () => {
      disposed = true;
      ready.current = false;
      activeRun.current = false;
      ++revision.current;
      clearTimeout(reconfigureTimer.current);
      transport.close();
      if (socket.current === transport) socket.current = null;
    };
  }, [reconnectKey, send]);

  const pause = useCallback(() => {
    clearTimeout(reconfigureTimer.current);
    activeRun.current = false;
    const id = ++revision.current;
    setRunning(false);
    setPending(false);
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return;
    try {
      socket.current.send(
        JSON.stringify({ type: "pause", id } satisfies EvolutionCommand),
      );
    } catch {
      ++revision.current;
      ready.current = false;
      setConnection("disconnected");
      setError("VM connection failed.");
      try {
        socket.current?.close();
      } catch {
        /* Transport already failed. */
      }
    }
  }, []);

  const replace = useCallback(
    (next: Experiment, search?: Partial<SearchSettings>) => {
      // A drag or a typed number must not become an RPC flood. Stop a live run
      // immediately; coalesce parameter edits before evaluating the newest input.
      if (activeRun.current) pause();
      clearTimeout(reconfigureTimer.current);
      const nextSettings = { ...current.current.settings, ...search };
      current.current = {
        experiment: next,
        settings: nextSettings,
        epoch: 0,
        cursor: nextSettings.randomSeed,
      };
      ++revision.current;
      setExperiment(next);
      setSettings(nextSettings);
      setEpoch(0);
      setScore(null);
      setHistory([]);
      setRunning(false);
      setPending(true);
      reconfigureTimer.current = setTimeout(() => send("evaluate"), 180);
    },
    [send, pause],
  );

  return {
    experiment,
    settings,
    simulation,
    connection,
    execution,
    running,
    pending,
    epoch,
    score,
    history,
    error,
    start: () => send("start"),
    step: () => send("step"),
    pause,
    replace,
    configure: (search: Partial<SearchSettings>) =>
      replace(current.current.experiment, search),
    reset: () => replace(current.current.experiment),
    reconnect: () => setReconnectKey((key) => key + 1),
    clearError: () => setError(""),
  };
}
