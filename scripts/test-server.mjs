import { build } from "esbuild";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { buildServer, root } from "./build-server.mjs";

await buildServer();
const tests = (await readdir(new URL("../server/", import.meta.url)))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
await build({
  absWorkingDir: root,
  entryPoints: tests.map((name) => `server/${name}`),
  outdir: ".server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  external: ["./index.js"],
  sourcemap: true,
});
const child = spawn(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    ...tests.map((name) => `.server/${name.replace(/\.ts$/, ".js")}`),
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
