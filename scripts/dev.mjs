/** Two small local processes: Vite UI + the same VM server/worker used in production. */
import { context } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { root, serverBuildOptions } from "./build-server.mjs";

let backend;
let frontend;
let buildContext;
let stopping = false;
let restart = Promise.resolve();
const children = new Set();
function launch(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.on("error", (error) => {
    console.error(error);
    void shutdown(1);
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  force.unref();
  await ended;
  clearTimeout(force);
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await buildContext?.dispose();
  await Promise.all([...children].map(stop));
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void shutdown();
  });

try {
  buildContext = await context({
    ...serverBuildOptions,
    plugins: [
      {
        name: "restart-vm-server",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length || stopping) return;
            restart = restart
              .then(async () => {
                const previous = backend;
                backend = undefined; // A deliberate restart is not an unexpected exit.
                await stop(previous);
                if (stopping) return;
                backend = launch([".server/index.js"], {
                  PORT: process.env.API_PORT ?? "8787",
                });
                const current = backend;
                backend.on("exit", (code, signal) => {
                  if (!stopping && current === backend && signal !== "SIGTERM")
                    void shutdown(code || 1);
                });
              })
              .catch((error) => {
                console.error(error);
                void shutdown(1);
              });
          });
        },
      },
    ],
  });
  await buildContext.watch();
  frontend = launch([
    "node_modules/vite/bin/vite.js",
    "--host",
    "0.0.0.0",
    "--port",
    process.env.CLIENT_PORT ?? "5173",
    "--strictPort",
  ]);
  frontend.on("exit", (code) => {
    if (!stopping) void shutdown(code || 1);
  });
} catch (error) {
  console.error(error);
  await shutdown(1);
}
