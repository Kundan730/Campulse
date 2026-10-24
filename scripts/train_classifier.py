"""Small, dependency-light model experiments on the synthetic waste benchmark."""

from __future__ import annotations

import time
import json
from pathlib import Path

import numpy as np
import pandas as pd


FEATURES = ["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"]


def fit_forest(X, y, classes, seed=11, trees=80, max_depth=14, min_leaf=8, features_per_split=2):
    rng = np.random.default_rng(seed)
    n, p = X.shape
    forest = []
    for _ in range(trees):
        sample = rng.integers(0, n, n)
        nodes = []

        def build(ids, depth):
            counts = np.bincount(y[ids], minlength=len(classes))
            idx = len(nodes)
            nodes.append(None)
            if depth >= max_depth or len(ids) < min_leaf * 2 or np.count_nonzero(counts) == 1:
                nodes[idx] = [-1, 0.0, -1, -1, counts.tolist()]
                return idx
            parent = 1.0 - float(np.square(counts / len(ids)).sum())
            best_gain = 0.0
            best = None
            for feature in rng.choice(p, min(features_per_split, p), replace=False):
                values = X[ids, feature]
                lo, hi = float(values.min()), float(values.max())
                if hi <= lo:
                    continue
                cuts = rng.uniform(lo, hi, size=12)
                for cut in cuts:
                    left = values <= cut
                    nl = int(left.sum())
                    nr = len(ids) - nl
                    if nl < min_leaf or nr < min_leaf:
                        continue
                    yl = np.bincount(y[ids[left]], minlength=len(classes))
                    yr = counts - yl
                    imp_l = 1.0 - float(np.square(yl / nl).sum())
                    imp_r = 1.0 - float(np.square(yr / nr).sum())
                    gain = parent - (nl * imp_l + nr * imp_r) / len(ids)
                    if gain > best_gain:
                        best_gain = gain
                        best = (int(feature), float(cut), ids[left], ids[~left])
            if best is None or best_gain < 0.002:
                nodes[idx] = [-1, 0.0, -1, -1, counts.tolist()]
                return idx
            feature, cut, left_ids, right_ids = best
            nodes[idx] = [feature, cut, -1, -1, counts.tolist()]
            left_index = build(left_ids, depth + 1)
            right_index = build(right_ids, depth + 1)
            nodes[idx][2] = left_index
            nodes[idx][3] = right_index
            return idx

        build(sample, 0)
        forest.append(nodes)
    return forest


def predict_one(forest, row, classes):
    votes = np.zeros(len(classes), dtype=float)
    for tree in forest:
        node = 0
        while tree[node][0] >= 0:
            feat, cut, left, right, _ = tree[node]
            node = left if row[feat] <= cut else right
        votes += np.asarray(tree[node][4], dtype=float) / max(sum(tree[node][4]), 1)
    return int(np.argmax(votes)), votes / len(forest)


def classification_report(y_true, y_pred, class_names):
    matrix = np.zeros((len(class_names), len(class_names)), dtype=int)
    for actual, predicted in zip(y_true, y_pred):
        matrix[int(actual), int(predicted)] += 1
    per_class = {}
    for i, name in enumerate(class_names):
        tp = int(matrix[i, i])
        precision = tp / max(int(matrix[:, i].sum()), 1)
        recall = tp / max(int(matrix[i, :].sum()), 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-12)
        per_class[name] = {
            "support": int(matrix[i, :].sum()),
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }
    return {
        "accuracy": float(np.trace(matrix) / max(int(matrix.sum()), 1)),
        "confusion_matrix": matrix.tolist(),
        "per_class": per_class,
        "macro_f1": float(np.mean([v["f1"] for v in per_class.values()])),
    }


def main():
    root = Path(__file__).resolve().parents[1]
    data = pd.read_excel(root / "P2P_DATASET" / "waste_events_train.xlsx")
    data["timestamp"] = pd.to_datetime(data["timestamp"])
    data = data.sort_values(["timestamp", "event_id"]).reset_index(drop=True)
    cutoff = data["timestamp"].quantile(0.8)
    train = data[data.timestamp < cutoff]
    valid = data[data.timestamp >= cutoff]
    classes = sorted(data.category.unique().tolist())
    class_to_id = {name: i for i, name in enumerate(classes)}
    medians = train[FEATURES].median().to_numpy(float)
    X_train = train[FEATURES].fillna(dict(zip(FEATURES, medians))).to_numpy(float)
    X_valid = valid[FEATURES].fillna(dict(zip(FEATURES, medians))).to_numpy(float)
    y_train = np.asarray([class_to_id[x] for x in train.category])
    y_valid = np.asarray([class_to_id[x] for x in valid.category])
    params = (80, 14, 8)
    started = time.perf_counter()
    holdout_forest = fit_forest(X_train, y_train, classes, trees=params[0], max_depth=params[1], min_leaf=params[2])
    train_s = time.perf_counter() - started
    started = time.perf_counter()
    valid_probabilities = np.asarray([predict_one(holdout_forest, row, classes)[1] for row in X_valid])
    holdout_seconds = time.perf_counter() - started
    valid_predictions = valid_probabilities.argmax(axis=1)
    report = classification_report(y_valid, valid_predictions, classes)

    # The shipped classifier is fit on all labeled rows after the chronological holdout is scored.
    full_medians = data[FEATURES].median().to_numpy(float)
    X_full = data[FEATURES].fillna(dict(zip(FEATURES, full_medians))).to_numpy(float)
    y_full = np.asarray([class_to_id[x] for x in data.category])
    shipped_forest = fit_forest(X_full, y_full, classes, trees=params[0], max_depth=params[1], min_leaf=params[2])

    def scrub(row):
        return [None if pd.isna(v) else float(v) for v in row]

    def predict_record(row):
        x = np.asarray([full_medians[i] if pd.isna(row[f]) else float(row[f]) for i, f in enumerate(FEATURES)])
        class_id, score = predict_one(shipped_forest, x, classes)
        ordered = sorted(zip(classes, score.tolist()), key=lambda pair: pair[1], reverse=True)
        return {
            "predicted_class": classes[class_id],
            "top_score": float(score[class_id]),
            "runner_up": ordered[1][0],
            "runner_up_score": float(ordered[1][1]),
            "needs_review": bool(score[class_id] < 0.72 or score[class_id] - ordered[1][1] < 0.12),
        }

    test = pd.read_excel(root / "P2P_DATASET" / "waste_events_test.xlsx")
    test["timestamp"] = pd.to_datetime(test.timestamp)
    test_predictions = []
    for _, row in test.iterrows():
        test_predictions.append({
            "event_id": str(row.event_id),
            "timestamp": row.timestamp.isoformat(),
            "building_id": str(row.building_id),
            "bin_id": str(row.bin_id),
            "features": {name: (None if pd.isna(row[name]) else float(row[name])) for name in FEATURES},
            **predict_record(row),
            "ground_truth_available": False,
        })

    out = root / "data"
    out.mkdir(parents=True, exist_ok=True)
    model = {
        "model_name": "ExtraTrees-style sensor forest",
        "features": FEATURES,
        "classes": classes,
        "imputation_medians": full_medians.tolist(),
        "trees": shipped_forest,
        "tree_count": len(shipped_forest),
        "node_count": sum(map(len, shipped_forest)),
        "max_depth": params[1],
        "min_leaf": params[2],
        "threshold_candidates_per_feature": 12,
        "random_seed": 11,
    }
    validation_latency_ms = holdout_seconds / len(valid) * 1000
    report.update({
        "validation_rows": len(valid),
        "training_rows": len(train),
        "chronological_cutoff": cutoff.isoformat(),
        "training_started_at": train.timestamp.min().isoformat(),
        "validation_started_at": valid.timestamp.min().isoformat(),
        "training_seconds": train_s,
        "python_validation_ms_per_event": validation_latency_ms,
        "validation_latency_note": "Batch holdout prediction time on the local Python/NumPy CPU runtime; see the Node benchmark for the shipped inference path.",
        "model": {k: model[k] for k in ("model_name", "tree_count", "node_count", "max_depth", "min_leaf")},
        "limitations": [
            "The benchmark is synthetic and sensor-only; no camera images or camera pipeline are present.",
            "E-waste and glass recall are weaker than the overall accuracy. Low-margin scores are routed for human review.",
            "The held-out labels are from a later benchmark period and do not establish real-campus performance.",
        ],
    })
    (out / "waste-model.json").write_text(json.dumps(model, separators=(",", ":")))
    (out / "waste-evaluation.json").write_text(json.dumps(report, indent=2))
    (out / "waste-test-predictions.json").write_text(json.dumps({"label_status": "unlabelled; predictions only", "events": test_predictions}, separators=(",", ":")))
    print(json.dumps({"evaluation": report, "node_count": model["node_count"], "holdout_train_seconds": round(train_s, 2), "holdout_valid_seconds": round(holdout_seconds, 2), "test_predictions": len(test_predictions)}, indent=2))


if __name__ == "__main__":
    main()
