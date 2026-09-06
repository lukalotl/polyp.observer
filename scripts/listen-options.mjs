/** Shared Vite-compatible listening flags for the dev and VM preview launchers. */
export function parseListenOptions(argv, defaults) {
  let port = defaults.port;
  let host = defaults.host ?? "0.0.0.0";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strictPort" || arg === "--") continue;
    if (arg === "--port" || arg === "-p") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} requires a port.`);
      port = argv[++i];
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    } else if (arg === "--host") {
      host =
        argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "0.0.0.0";
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else {
      throw new Error(
        `Unsupported option: ${arg}. Use --port, --host, --strictPort.`,
      );
    }
  }
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Port must be an integer from 1 through 65535.");
  if (typeof host !== "string" || !host.trim())
    throw new Error("Host must not be empty.");
  return { port: Number(port), host };
}
