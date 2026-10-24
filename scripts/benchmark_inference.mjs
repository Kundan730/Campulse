import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWaste } from "../lib/classifier.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const model = JSON.parse(fs.readFileSync(path.join(dataDir, "waste-model.json"), "utf8"));
const testData = JSON.parse(fs.readFileSync(path.join(dataDir, "waste-test-predictions.json"), "utf8"));
const events = testData.events;
if (!events?.length) throw new Error("No unlabelled test events are available to benchmark.");

for (const event of events.slice(0, 40)) classifyWaste(model, event.features);
const durations = events.map((event) => classifyWaste(model, event.features).latencyMs).sort((a, b) => a - b);
const sum = durations.reduce((total, value) => total + value, 0);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)];
const report = {
  inferencePath: "same classifyWaste function used by POST /api/classify",
  model: model.model_name,
  treeCount: model.tree_count,
  nodeCount: model.node_count,
  measuredEvents: durations.length,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  meanMs: sum / durations.length,
  maxMs: durations.at(-1),
  throughputEventsPerSecond: durations.length / (sum / 1000),
  runtime: process.version,
  platform: process.platform,
  architecture: process.arch,
  hardwareNote: "Measurement describes this Node host. Raspberry Pi hardware was not available for direct benchmarking.",
};
fs.writeFileSync(path.join(dataDir, "waste-inference-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
