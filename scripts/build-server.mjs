import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const serverBuildOptions = {
  absWorkingDir: root,
  entryPoints: ["server/index.ts", "server/worker.ts"],
  outdir: ".server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
};
export async function buildServer() {
  await build(serverBuildOptions);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildServer();
