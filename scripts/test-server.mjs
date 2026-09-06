import { build } from "esbuild";
import { spawn } from "node:child_process";
import { buildServer, root } from "./build-server.mjs";

await buildServer();
await build({
  absWorkingDir: root,
  entryPoints: ["server/evolution.test.ts"],
  outfile: ".server/evolution.test.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  external: ["./index.js"],
  sourcemap: true,
});
const child = spawn(process.execPath, ["--test", ".server/evolution.test.js"], {
  cwd: root,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
