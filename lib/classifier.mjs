import { performance } from "node:perf_hooks";

export function classifyWaste(model, features) {
  const started = performance.now();
  const imputedFeatures = [];
  const vector = model.features.map((name, index) => {
    const value = features[name];
    if (!Number.isFinite(value)) imputedFeatures.push(name);
    return Number.isFinite(value) ? value : model.imputation_medians[index];
  });
  const scores = new Array(model.classes.length).fill(0);
  for (const tree of model.trees) {
    let nodeIndex = 0;
    while (tree[nodeIndex][0] >= 0) {
      const node = tree[nodeIndex];
      nodeIndex = vector[node[0]] <= node[1] ? node[2] : node[3];
    }
    const counts = tree[nodeIndex][4];
    const total = counts.reduce((sum, count) => sum + count, 0) || 1;
    for (let i = 0; i < counts.length; i += 1) scores[i] += counts[i] / total;
  }
  for (let i = 0; i < scores.length; i += 1) scores[i] /= model.tree_count;
  const rank = scores.map((score, index) => ({ className: model.classes[index], score })).sort((a, b) => b.score - a.score);
  const latencyMs = performance.now() - started;
  return {
    predictedClass: rank[0].className,
    topScore: rank[0].score,
    runnerUp: rank[1].className,
    runnerUpScore: rank[1].score,
    scores: Object.fromEntries(rank.map(({ className, score }) => [className, score])),
    needsReview: rank[0].score < 0.72 || rank[0].score - rank[1].score < 0.12,
    imputedFeatures,
    scoreMeaning: "Uncalibrated model score, not a verified probability.",
    latencyMs,
  };
}
