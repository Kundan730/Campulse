"""Time-aware electricity forecast experiment with arrival-time-safe features."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


HISTORY = [24, 48, 168]
BASE_FEATURES = ["lag24", "lag48", "lag168", "latest", "rolling6", "footfall24", "latest_footfall"]


def feature_row(frame, target_ts, horizon, building_id, calendar):
    origin = target_ts - pd.Timedelta(hours=horizon)
    by_capture = frame
    vals = {}
    for lag in HISTORY:
        stamp = target_ts - pd.Timedelta(hours=lag)
        if stamp not in by_capture:
            return None
        row = by_capture[stamp]
        if row["received_at"] > origin or pd.isna(row["electricity_kwh"]):
            return None
        vals[f"lag{lag}"] = float(row["electricity_kwh"])
    recent_energy, recent_footfall = [], []
    latest = None
    for lag in range(1, 25):
        row = by_capture.get(origin - pd.Timedelta(hours=lag))
        if row is not None and row["received_at"] <= origin:
            latest = row
            if not pd.isna(row["electricity_kwh"]):
                recent_energy.append(float(row["electricity_kwh"]))
            if not pd.isna(row["footfall"]):
                recent_footfall.append(float(row["footfall"]))
            if len(recent_energy) >= 6 and len(recent_footfall) >= 6:
                break
    if latest is None:
        return None
    vals["latest"] = float(latest["electricity_kwh"]) if not pd.isna(latest["electricity_kwh"]) else vals["lag24"]
    vals["rolling6"] = float(np.mean(recent_energy[:6])) if recent_energy else np.nan
    day_lag = by_capture[target_ts - pd.Timedelta(hours=24)]
    vals["footfall24"] = float(day_lag["footfall"]) if not pd.isna(day_lag["footfall"]) else np.nan
    vals["latest_footfall"] = recent_footfall[0] if recent_footfall else np.nan
    dow = target_ts.dayofweek
    hour = target_ts.hour
    vals["hour_sin"] = float(np.sin(2 * np.pi * hour / 24))
    vals["hour_cos"] = float(np.cos(2 * np.pi * hour / 24))
    vals["dow_sin"] = float(np.sin(2 * np.pi * dow / 7))
    vals["dow_cos"] = float(np.cos(2 * np.pi * dow / 7))
    calendar_row = calendar[target_ts.normalize()]
    vals["event"] = float(bool(calendar_row["event"]))
    vals["is_working"] = float(calendar_row["day_type"] in ("working", "exam"))
    vals["is_weekend"] = float(calendar_row["day_type"] == "weekend")
    vals["is_exam"] = float("exam" in str(calendar_row["day_type"]).lower() or "exam" in str(calendar_row["event"]).lower())
    vals["building_id"] = building_id
    return vals


def build_samples(hourly, calendar, horizon):
    rows = []
    for building_id, frame in hourly.groupby("building_id", sort=True):
        frame = frame.sort_values(["timestamp", "received_at"])
        by_capture = {row.timestamp: row._asdict() for row in frame.itertuples(index=False)}
        for target_ts, target_row in by_capture.items():
            if pd.isna(target_row["electricity_kwh"]):
                continue
            features = feature_row(by_capture, target_ts, horizon, building_id, calendar)
            if features is None:
                continue
            if not np.isfinite(list(features[k] for k in BASE_FEATURES)).all():
                continue
            features["timestamp"] = target_ts
            features["y"] = float(target_row["electricity_kwh"])
            features["baseline"] = features["lag24"]
            rows.append(features)
    return pd.DataFrame(rows)


def encode(samples, building_order):
    names = BASE_FEATURES + ["hour_sin", "hour_cos", "dow_sin", "dow_cos", "event", "is_working", "is_weekend", "is_exam"]
    x = samples[names].to_numpy(float)
    onehot = np.zeros((len(samples), len(building_order)), dtype=float)
    ix = {b: i for i, b in enumerate(building_order)}
    onehot[np.arange(len(samples)), [ix[b] for b in samples.building_id]] = 1.0
    return np.column_stack([x, onehot]), names + [f"building_{b}" for b in building_order]


def metrics(y, pred):
    err = pred - y
    return {"mae": float(np.mean(np.abs(err))), "rmse": float(np.sqrt(np.mean(err**2))), "wape_pct": float(np.sum(np.abs(err)) / np.sum(np.abs(y)) * 100)}


def ridge_coefficients(z, y, alpha):
    """Fit a centered ridge model and reject non-finite numerical results."""
    if not np.isfinite(z).all() or not np.isfinite(y).all():
        raise ValueError("Ridge inputs must be finite after imputation and scaling.")
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        gram = z.T @ z + alpha * np.eye(z.shape[1])
        target = z.T @ y
        if not np.isfinite(gram).all() or not np.isfinite(target).all():
            raise ArithmeticError("Ridge matrix products produced non-finite values.")
        coefficients = np.linalg.solve(gram, target)
    if not np.isfinite(coefficients).all():
        raise ArithmeticError("Ridge fitting produced non-finite coefficients.")
    return coefficients


def ridge_predict(z, coefficients, target_mean):
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        predictions = np.maximum(0, target_mean + z @ coefficients)
    if not np.isfinite(predictions).all():
        raise ArithmeticError("Ridge prediction produced non-finite values.")
    return predictions


def main():
    root = Path(__file__).resolve().parents[1]
    hourly = pd.read_excel(root / "P2P_DATASET" / "hourly_streams.xlsx")
    hourly["timestamp"] = pd.to_datetime(hourly.timestamp)
    hourly["received_at"] = pd.to_datetime(hourly.received_at)
    hourly = hourly.sort_values(["building_id", "timestamp", "received_at"]).drop_duplicates(["building_id", "timestamp"], keep="last")
    calendar = pd.read_excel(root / "P2P_DATASET" / "calendar.xlsx")
    calendar["date"] = pd.to_datetime(calendar.date)
    calendar = calendar.set_index("date").to_dict(orient="index")
    buildings = sorted(hourly.building_id.unique())
    output = {"method": "Arrival-time-safe 6h and 12h ridge forecast compared with same-hour-yesterday seasonal naive", "target": "building electricity_kwh per captured hour", "models": {}, "evaluation": {}}
    for horizon in (6, 12):
        samples = build_samples(hourly, calendar, horizon)
        cutoff = samples.timestamp.quantile(0.8)
        train = samples[samples.timestamp < cutoff].copy()
        valid = samples[samples.timestamp >= cutoff].copy()
        X, names = encode(samples, buildings)
        train_ix = np.flatnonzero(samples.timestamp < cutoff)
        valid_ix = np.flatnonzero(samples.timestamp >= cutoff)
        X_train, X_valid = X[train_ix].copy(), X[valid_ix].copy()
        y_train, y_valid = samples.y.to_numpy()[train_ix], samples.y.to_numpy()[valid_ix]
        medians = np.nanmedian(X_train, axis=0)
        medians[~np.isfinite(medians)] = 0.0
        for arr in (X_train, X_valid):
            missing = ~np.isfinite(arr)
            arr[missing] = np.broadcast_to(medians, arr.shape)[missing]
        mean = X_train.mean(0)
        scale = X_train.std(0)
        scale[scale < 1e-8] = 1.0
        Z_train = (X_train - mean) / scale
        Z_valid = (X_valid - mean) / scale
        ym = y_train.mean()
        alpha = 8.0
        coef = ridge_coefficients(Z_train, y_train - ym, alpha)
        pred = ridge_predict(Z_valid, coef, ym)
        baseline = np.maximum(0, samples.baseline.to_numpy()[valid_ix])
        baseline_metrics = metrics(y_valid, baseline)
        model_metrics = metrics(y_valid, pred)
        p90 = float(np.quantile(np.abs(pred-y_valid), .9))

        # Refit on the full benchmark history to drive the selectable replay forecast.
        X_full, names = encode(samples, buildings)
        final_medians = np.nanmedian(X_full, axis=0)
        final_medians[~np.isfinite(final_medians)] = 0.0
        missing = ~np.isfinite(X_full)
        X_full[missing] = np.broadcast_to(final_medians, X_full.shape)[missing]
        final_mean = X_full.mean(0)
        final_scale = X_full.std(0)
        final_scale[final_scale < 1e-8] = 1.0
        Z_full = (X_full - final_mean) / final_scale
        final_ym = float(samples.y.mean())
        final_coef = ridge_coefficients(Z_full, samples.y.to_numpy() - final_ym, alpha)

        output["evaluation"][str(horizon)] = {
            "horizon_hours": horizon,
            "target_start": samples.timestamp.min().isoformat(),
            "validation_cutoff": cutoff.isoformat(),
            "training_rows": int(len(train)),
            "validation_rows": int(len(valid)),
            "seasonal_naive": baseline_metrics,
            "ridge": model_metrics,
            "ridge_validation_abs_error_p90_kwh": p90,
            "time_aware_split": "chronological by target timestamp; final 20% held out; features use only records whose received_at is no later than the forecast origin",
        }
        output["models"][str(horizon)] = {
            "horizon_hours": horizon,
            "feature_names": names,
            "imputation_medians": final_medians.tolist(),
            "means": final_mean.tolist(),
            "scales": final_scale.tolist(),
            "coefficients": final_coef.tolist(),
            "target_mean": final_ym,
            "ridge_alpha": alpha,
            "validation_abs_error_p90_kwh": p90,
            "training_rows": int(len(samples)),
        }
        print("horizon", horizon, "samples", len(samples), "train", len(train), "valid", len(valid), "cutoff", cutoff)
        print("seasonal_baseline", {k: round(v, 3) for k,v in baseline_metrics.items()})
        print("ridge", {k: round(v, 3) for k,v in model_metrics.items()}, "abs_error_p90", round(p90, 2))
    output["limitations"] = [
        "The target series is synthetic and only covers 120 days.",
        "The model uses scheduled calendar context and past telemetry, not future observed weather or future footfall.",
        "Validation residual bands describe the held-out benchmark period and are not guaranteed campus intervals.",
    ]
    out = root / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "forecast.json").write_text(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
