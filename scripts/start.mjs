import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const benchmark = spawnSync(process.execPath, [path.join(root, "scripts", "benchmark_inference.mjs")], {
  cwd: root,
  stdio: "inherit",
});

if (benchmark.error) throw benchmark.error;
if (benchmark.status !== 0) process.exit(benchmark.status ?? 1);

const server = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
server.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 0;
});
