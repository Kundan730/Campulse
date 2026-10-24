"""Prepare immutable workbook sources for the local Campulse demo."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "P2P_DATASET"
OUT = ROOT / "data"
FEATURES = ["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"]
ALIASES = {
    "B01": ["b01", "academic block a", "acad block a", "block a"],
    "B02": ["b02", "academic block b", "acad block b", "block b"],
    "B03": ["b03", "central library", "central lib", "library"],
    "B04": ["b04", "engineering labs & innovation centre", "eng labs", "innovation centre", "labs"],
    "B05": ["b05", "boys hostel", "boys hostle", "bh"],
    "B06": ["b06", "girls hostel", "girls hostle", "gh"],
    "B07": ["b07", "food court", "canteen", "fc"],
    "B08": ["b08", "admin block", "admin"],
}
ALIAS_LOOKUP = {alias: building_id for building_id, aliases in ALIASES.items() for alias in aliases}


def json_value(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp, np.datetime64)):
        return pd.Timestamp(value).isoformat()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def records(frame):
    return [{str(k): json_value(v) for k, v in row.items()} for row in frame.to_dict(orient="records")]


def normalized_alias(value):
    return re.sub(r"\s+", " ", str(value).strip().lower())


def audit_source(file_name, frame, sheet_name, key_columns=None, time_columns=()):
    key_columns = key_columns or []
    date_ranges = {}
    for name in time_columns:
        dates = pd.to_datetime(frame[name], errors="coerce")
        date_ranges[name] = {
            "min": dates.min().isoformat() if dates.notna().any() else None,
            "max": dates.max().isoformat() if dates.notna().any() else None,
            "invalid": int(dates.isna().sum()),
        }
    return {
        "file": file_name,
        "sheet": sheet_name,
        "rows": int(len(frame)),
        "columns": [str(c) for c in frame.columns if c != "source_row"],
        "dtypes": {str(k): str(v) for k, v in frame.dtypes.items() if k != "source_row"},
        "missing": {str(k): int(v) for k, v in frame.isna().sum().items() if v and k != "source_row"},
        "duplicate_full_rows": int(frame.drop(columns=["source_row"], errors="ignore").duplicated().sum()),
        "key_columns": key_columns,
        "duplicate_keys": int(frame.duplicated(key_columns).sum()) if key_columns else None,
        "date_ranges": date_ranges,
    }


def normalize_logs(frame, daily):
    building_types = {
        row.building_id: row.building_type
        for row in pd.read_excel(SOURCE / "buildings.xlsx").itertuples(index=False)
    }
    normalized = []
    duplicate_window = {}
    for row in frame.itertuples(index=False):
        record = row._asdict()
        alias = normalized_alias(record["building"])
        building_id = ALIAS_LOOKUP.get(alias)
        stream = str(record["stream"]).lower()
        raw_value = record["value"]
        raw_unit = record["unit"]
        value = None if pd.isna(raw_value) else float(raw_value)
        unit = None if pd.isna(raw_unit) else str(raw_unit)
        normalized_value, normalized_unit = value, unit
        if stream == "electricity" and value is not None and unit and unit.lower() in ("kwh", "units"):
            normalized_unit = "kWh"
        elif stream == "water" and value is not None and unit:
            if unit.lower() == "kl":
                normalized_value, normalized_unit = value * 1000.0, "L"
            elif unit.lower() == "l":
                normalized_unit = "L"
        elif stream == "waste" and value is not None and unit:
            if unit.lower() == "bags":
                normalized_value, normalized_unit = value * 8.0, "kg"
            elif unit.lower() == "kg":
                normalized_unit = "kg"
        note = "" if pd.isna(record["note"]) else str(record["note"])
        flags = []
        if building_id is None:
            flags.append("unmapped_building_alias")
        if value is None and stream != "note":
            flags.append("missing_manual_value")
        if note and "approx" in note.lower():
            flags.append("approximate_operator_entry")
        if normalized_value is not None and normalized_unit == "L" and building_id is not None:
            day = pd.Timestamp(record["logged_at"]).normalize()
            candidates = daily[(daily.building_id == building_id) & (pd.to_datetime(daily.date) == day)]
            if len(candidates) and not pd.isna(candidates.iloc[0].water_litres):
                comparable = float(candidates.iloc[0].water_litres)
                if normalized_value > max(comparable * 8, 10000):
                    flags.append("possible_magnitude_conflict_with_daily_summary")
        if stream == "note":
            if re.search(r"leak|meter|inverter|composter|pump|calibrat|fault|flicker|stuck", note, re.I):
                flags.append("maintenance_or_meter_note")
        if building_id is not None and value is not None:
            stamp = pd.Timestamp(record["logged_at"])
            signature = (building_id, stream, normalized_value, normalized_unit, note.strip().lower())
            previous = duplicate_window.get(signature)
            if previous is not None and abs((stamp - previous).total_seconds()) <= 1800:
                flags.append("possible_repeated_manual_entry")
            duplicate_window[signature] = stamp
        normalized.append({
            "log_id": str(record["log_id"]),
            "logged_at": json_value(record["logged_at"]),
            "logger_role": str(record["logger_role"]),
            "building_alias_raw": str(record["building"]),
            "building_id_normalized": building_id,
            "building_type_benchmark": building_types.get(building_id),
            "stream_raw": stream,
            "value_raw": json_value(raw_value),
            "unit_raw": unit,
            "value_normalized": normalized_value,
            "unit_normalized": normalized_unit,
            "note_raw": note or None,
            "source_file": "manual_logs.xlsx",
            "source_sheet": "manual_logs",
            "source_row": int(record["source_row"]),
            "quality_flags": flags,
        })
    return normalized


def hourly_records(frame):
    measurement_columns = ["electricity_kwh", "water_litres", "solar_generation_kwh", "footfall"]
    keys = ["building_id", "timestamp"]
    robust_bounds = {}
    time_bucket = pd.to_datetime(frame.timestamp).dt.hour
    for (building_id, hour_of_day), group in frame.assign(_hour_of_day=time_bucket).groupby(["building_id", "_hour_of_day"], sort=False):
        for column in measurement_columns:
            values = pd.to_numeric(group[column], errors="coerce").dropna().to_numpy()
            if len(values) < 20:
                continue
            median = float(np.median(values))
            mad = float(np.median(np.abs(values - median)))
            if mad > 0:
                radius = 8 * 1.4826 * mad
                robust_bounds[(building_id, int(hour_of_day), column)] = (median - radius, median + radius)
    counts = frame.groupby(keys, sort=False, dropna=False).size().to_dict()
    ranked = frame.assign(
        _nonmissing=frame[measurement_columns].notna().sum(axis=1),
        _received_sort=pd.to_datetime(frame.received_at),
    ).sort_values(["_nonmissing", "_received_sort", "source_row"], kind="mergesort")
    winners = ranked.drop_duplicates(keys, keep="last").sort_values(["timestamp", "building_id"], kind="mergesort")

    duplicate_rows = frame[frame.duplicated(keys, keep=False)]
    duplicate_meta = {}
    conflicting_group_count = 0
    for (building_id, timestamp), group in duplicate_rows.groupby(keys, sort=False, dropna=False):
        conflict = len(group[measurement_columns].drop_duplicates()) > 1
        conflicting_group_count += int(conflict)
        revisions = [
            {"source_row": int(row.source_row), "received_at": json_value(row.received_at), **{column: json_value(getattr(row, column)) for column in measurement_columns}}
            for row in group.itertuples(index=False)
        ]
        duplicate_meta[(building_id, timestamp)] = ([int(value) for value in group.source_row.tolist()], revisions, conflict)

    normalized = []
    for winner in winners.itertuples(index=False):
        record = winner._asdict()
        building_id, timestamp = record["building_id"], record["timestamp"]
        source_rows, revisions, conflict = duplicate_meta.get((building_id, timestamp), ([int(record["source_row"])], [], False))
        source_count = counts[(building_id, timestamp)]
        lag_hours = (pd.Timestamp(record["received_at"]) - pd.Timestamp(timestamp)).total_seconds() / 3600
        flags = []
        if source_count > 1:
            flags.append("duplicate_retransmission_deduped")
        if conflict:
            flags.append("duplicate_values_conflict")
        if lag_hours > 2:
            flags.append("delayed_arrival")
        if lag_hours > 6:
            flags.append("severely_delayed_arrival")
        for column in measurement_columns:
            if pd.isna(record[column]):
                flags.append(f"missing_{column}")
                continue
            bounds = robust_bounds.get((building_id, pd.Timestamp(timestamp).hour, column))
            if bounds and not bounds[0] <= float(record[column]) <= bounds[1]:
                flags.append(f"possible_noisy_spike_{column}")
        normalized.append({
            "timestamp": json_value(timestamp),
            "received_at": json_value(record["received_at"]),
            "building_id": str(building_id),
            **{column: json_value(record[column]) for column in measurement_columns},
            "arrival_lag_hours": round(lag_hours, 3),
            "source_file": "hourly_streams.xlsx",
            "source_sheet": "hourly_streams",
            "source_row": int(record["source_row"]),
            "source_rows_for_capture": source_rows,
            "source_count": int(source_count),
            "duplicate_revisions": revisions,
            "quality_flags": flags,
        })
    normalized.sort(key=lambda row: (row["timestamp"], row["building_id"]))
    duplicate_group_count = len(duplicate_meta)
    return normalized, duplicate_group_count, conflicting_group_count


def make_audit_markdown(audits, relation_summary):
    lines = [
        "# Dataset inspection",
        "",
        "Source workbooks were opened read-only. The application consumes the workbook sheets directly through `scripts/prepare_data.py`; the source files remain unchanged.",
        "",
        "## Workbook coverage",
        "",
        "| Workbook and sheet | Rows × columns | Date range | Missing values | Duplicate rows / keys |",
        "|---|---:|---|---|---|",
    ]
    for audit in audits:
        dates = audit["date_ranges"]
        date_text = ", ".join(f"{key}: {value['min']} to {value['max']}" for key, value in dates.items()) or "static table"
        missing = ", ".join(f"{key} {value}" for key, value in audit["missing"].items()) or "none"
        keys = f"{audit['duplicate_full_rows']} exact / {audit['duplicate_keys']} key" if audit["key_columns"] else f"{audit['duplicate_full_rows']} exact"
        lines.append(f"| `{audit['file']}` · `{audit['sheet']}` | {audit['rows']} × {len(audit['columns'])} | {date_text} | {missing} | {keys} |")
    lines += ["", "## Fields, units, and types", ""]
    for audit in audits:
        lines += [f"### `{audit['file']}` / `{audit['sheet']}`", "", "| Field | Workbook type | Meaning / unit |", "|---|---|---|"]
        for col in audit["columns"]:
            unit = FIELD_UNITS.get(audit["file"], {}).get(col, "identifier or descriptive field")
            lines.append(f"| `{col}` | {audit['dtypes'].get(col, 'unknown')} | {unit} |")
        lines.append("")
    lines += [
        "## Relationships and quality findings",
        "",
        f"- The buildings master has {relation_summary['buildings']} unique IDs. Daily summaries contain {relation_summary['daily_rows']} unique `(date, building_id)` keys, exactly {relation_summary['daily_expected']} expected keys. Hourly capture data contains {relation_summary['hourly_unique_keys']} unique `(building_id, timestamp)` keys of {relation_summary['hourly_expected']} expected; {relation_summary['hourly_missing_keys']} expected keys are absent and {relation_summary['hourly_duplicate_groups']} capture keys have retransmissions. {relation_summary['hourly_conflicting_groups']} duplicate groups contain differing readings.",
        f"- A retrospective, same-hour-of-day robust check flagged {relation_summary['hourly_possible_noisy_values']} possible noisy hourly values; values were retained without smoothing. A production detector must use past-only history.",
        f"- All manual aliases mapped: {relation_summary['mapped_manual_logs']} / {relation_summary['manual_logs']}. Logs are normalized for joining, but they never overwrite the hourly or daily telemetry. The source log ID remains the idempotency key. Repeated readings within 30 minutes are flagged for review.",
        f"- Calendar and daily summaries share the 120-day range. Both labeled and unlabelled waste event tables refer to the same eight benchmark IDs. The unlabelled table has no target column and is used only for predictions.",
        "- The guide names `waste_class`; the actual training workbook uses `category`. Training uses the workbook column. There are no CSV files or `excel_format/` subfolder in the supplied directory; only the seven top-level `.xlsx` workbooks are present.",
        "- Excel timestamps have no timezone metadata. The demo preserves their naive local-time representation and does not silently convert them. Campus operations are expected to be in IST; confirm device time zones before real ingestion.",
        "- Hourly values and daily summaries are separate grains. Daily dashboard totals use `daily_summary`; hourly charts use `hourly_streams`. They are not added together. Missing numeric cells remain null and are displayed as unavailable rather than zero.",
        "- Waste mass total uses `composted_kg + recycled_kg + landfill_kg` to avoid counting category totals and diverted mass twice. Category mass is still available separately. The benchmark's mass-balance relation has high correlation but small rounding and occasional larger differences, so category sums are not forced to equal the disposal total.",
        "",
        "## Normalization rules",
        "",
        "- Manual aliases map the dataset's eight synthetic building labels to B01–B08 using a fixed, auditable alias table in `scripts/prepare_data.py`.",
        "- `units` and `kWh` become kWh; `kL` becomes 1,000 L; `L` stays L; `bags` become an approximate 8 kg per bag; `kg` stays kg. Original value and unit are retained beside the normalized value.",
        "- Hourly retransmissions are grouped by `(building_id, timestamp)`. Winner is the row with the most nonmissing measurements, then latest `received_at`, then greatest workbook row number. Every selected source row and duplicate revision is retained in the processed data, with flags.",
        "- Hourly values beyond eight scaled median absolute deviations from their building/channel/hour-of-day group are flagged as possible spikes. This retrospective full-window audit does not claim causality or replace a streaming past-only detector.",
        "- A delay over two hours is flagged; over six hours is severe. Capture time (`timestamp`) and server arrival (`received_at`) are separate fields. Replay availability follows arrival time.",
        "",
    ]
    return "\n".join(lines)


def build_sqlite(tables, buildings, calendar, daily, hourly, manuals, relations, benchmark, audits):
    database_path = OUT / "campulse.sqlite"
    with sqlite3.connect(database_path) as db:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=NORMAL")
        for table in ("buildings", "calendar", "daily", "hourly", "manual_logs", "source_rows", "dataset_meta", "demo_sessions", "demo_offline", "demo_queue", "demo_sync_log"):
            db.execute(f"DROP TABLE IF EXISTS {table}")
        db.executescript("""
            CREATE TABLE buildings (building_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
            CREATE TABLE calendar (date TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
            CREATE TABLE daily (date TEXT NOT NULL, building_id TEXT NOT NULL, payload_json TEXT NOT NULL,
              PRIMARY KEY(date, building_id));
            CREATE TABLE hourly (building_id TEXT NOT NULL, timestamp TEXT NOT NULL, received_at TEXT NOT NULL,
              payload_json TEXT NOT NULL, source_count INTEGER NOT NULL, PRIMARY KEY(building_id, timestamp));
            CREATE INDEX hourly_arrival_idx ON hourly(received_at);
            CREATE TABLE manual_logs (log_id TEXT PRIMARY KEY, logged_at TEXT NOT NULL, building_id TEXT, payload_json TEXT NOT NULL);
            CREATE INDEX manual_arrival_idx ON manual_logs(logged_at);
            CREATE TABLE source_rows (source_file TEXT NOT NULL, source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
              payload_json TEXT NOT NULL, PRIMARY KEY(source_file, source_sheet, source_row));
            CREATE TABLE dataset_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        """)
        db.executemany("INSERT INTO buildings VALUES (?,?)", [(str(x["building_id"]), json.dumps(x, separators=(",", ":"))) for x in buildings])
        db.executemany("INSERT INTO calendar VALUES (?,?)", [(str(x["date"]), json.dumps(x, separators=(",", ":"))) for x in calendar])
        db.executemany("INSERT INTO daily VALUES (?,?,?)", [(str(x["date"]), str(x["building_id"]), json.dumps(x, separators=(",", ":"))) for x in daily])
        db.executemany("INSERT INTO hourly VALUES (?,?,?,?,?)", [(str(x["building_id"]), str(x["timestamp"]), str(x["received_at"]), json.dumps(x, separators=(",", ":")), int(x["source_count"])) for x in hourly])
        db.executemany("INSERT INTO manual_logs VALUES (?,?,?,?)", [(str(x["log_id"]), str(x["logged_at"]), x["building_id_normalized"], json.dumps(x, separators=(",", ":"))) for x in manuals])
        db.executemany("INSERT INTO dataset_meta VALUES (?,?)", [
            ("relations", json.dumps(relations)),
            ("benchmark", json.dumps(benchmark)),
            ("sources", json.dumps(audits)),
        ])
        for file_name, frame in tables.items():
            sheet = file_name
            rows = records(frame)
            db.executemany("INSERT INTO source_rows VALUES (?,?,?,?)", [(f"{file_name}.xlsx", sheet, int(x["source_row"]), json.dumps(x, separators=(",", ":"))) for x in rows])
        db.commit()
    return database_path


FIELD_UNITS = {
    "buildings.xlsx": {"building_id": "synthetic primary key", "building_name": "synthetic benchmark label, not a Chanakya University mapping", "building_type": "synthetic benchmark type", "floors": "count, hypothetical metadata", "area_sqm": "m², hypothetical metadata", "design_capacity": "persons, hypothetical metadata", "has_solar": "boolean-like 0/1", "solar_capacity_kw": "kW, hypothetical metadata", "year_built": "year, hypothetical metadata", "has_composter": "boolean-like 0/1"},
    "calendar.xlsx": {"date": "local date", "day_of_week": "weekday label", "day_type": "synthetic schedule category", "event": "optional event description", "avg_temp_c": "°C, daily mean", "rainfall_mm": "mm, daily total", "humidity_pct": "%"},
    "daily_summary.xlsx": {"date": "local date", "building_id": "synthetic building key", "occupancy_avg": "estimated people/day", "electricity_kwh": "kWh/day", "water_litres": "L/day", "solar_generation_kwh": "kWh/day", "wet_organic_kg": "kg/day", "dry_recyclable_kg": "kg/day", "ewaste_kg": "kg/day", "hazardous_kg": "kg/day", "composted_kg": "kg/day diverted", "recycled_kg": "kg/day diverted", "contamination_pct": "%", "landfill_kg": "kg/day"},
    "hourly_streams.xlsx": {"timestamp": "capture local timestamp", "received_at": "server arrival local timestamp", "building_id": "synthetic building key", "electricity_kwh": "kWh per hour", "water_litres": "L per hour", "solar_generation_kwh": "kWh per hour", "footfall": "turnstile passages/hour"},
    "manual_logs.xlsx": {"log_id": "unique manual log ID", "logged_at": "operator entry local timestamp", "logger_role": "operator role", "building": "free-text building alias", "stream": "electricity / water / waste / note", "value": "number, interpreted with unit", "unit": "kWh / units / L / kL / kg / bags", "note": "free-text observation"},
    "waste_events_train.xlsx": {"event_id": "unique event ID", "timestamp": "capture local timestamp", "building_id": "synthetic building key", "bin_id": "synthetic bin key", "weight_g": "g", "moisture_pct": "%", "metal_signal": "sensor response, unitless", "transparency": "unitless coefficient 0–1", "acoustic_hardness": "unitless coefficient 0–1", "category": "six-class label"},
    "waste_events_test.xlsx": {"event_id": "unique event ID", "timestamp": "capture local timestamp", "building_id": "synthetic building key", "bin_id": "synthetic bin key", "weight_g": "g", "moisture_pct": "%", "metal_signal": "sensor response, unitless", "transparency": "unitless coefficient 0–1", "acoustic_hardness": "unitless coefficient 0–1"},
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tables = {}
    audits = []
    specifications = [
        ("buildings", ["building_id"], ()),
        ("calendar", ["date"], ("date",)),
        ("daily_summary", ["date", "building_id"], ("date",)),
        ("hourly_streams", ["building_id", "timestamp"], ("timestamp", "received_at")),
        ("manual_logs", ["log_id"], ("logged_at",)),
        ("waste_events_train", ["event_id"], ("timestamp",)),
        ("waste_events_test", ["event_id"], ("timestamp",)),
    ]
    for name, key, time_columns in specifications:
        path = SOURCE / f"{name}.xlsx"
        workbook = pd.ExcelFile(path)
        sheet = workbook.sheet_names[0]
        frame = pd.read_excel(path, sheet_name=sheet)
        frame["source_row"] = np.arange(2, len(frame) + 2)
        audits.append(audit_source(path.name, frame, sheet, key, time_columns))
        tables[name] = frame

    buildings = records(tables["buildings"])
    calendar = records(tables["calendar"])
    daily = records(tables["daily_summary"])
    hourly, duplicate_groups, conflicting_groups = hourly_records(tables["hourly_streams"])
    manuals = normalize_logs(tables["manual_logs"], tables["daily_summary"])

    building_ids = set(tables["buildings"].building_id.astype(str))
    hourly_unique = int(tables["hourly_streams"].drop_duplicates(["building_id", "timestamp"]).shape[0])
    daily_unique = int(tables["daily_summary"].drop_duplicates(["date", "building_id"]).shape[0])
    date_count = int(pd.to_datetime(tables["calendar"].date).nunique())
    relations = {
        "buildings": len(building_ids),
        "daily_rows": daily_unique,
        "daily_expected": date_count * len(building_ids),
        "hourly_unique_keys": hourly_unique,
        "hourly_expected": date_count * 24 * len(building_ids),
        "hourly_missing_keys": date_count * 24 * len(building_ids) - hourly_unique,
        "hourly_duplicate_groups": duplicate_groups,
        "hourly_conflicting_groups": conflicting_groups,
        "hourly_possible_noisy_values": sum(
            1 for row in hourly for flag in row["quality_flags"] if flag.startswith("possible_noisy_spike_")
        ),
        "manual_logs": len(manuals),
        "mapped_manual_logs": sum(1 for item in manuals if item["building_id_normalized"] in building_ids),
    }
    manifest = {
        "benchmark": {
            "label": "Synthetic / hypothetical operational benchmark",
            "window_start": "2026-06-20",
            "window_end": "2026-10-17",
            "timezone_metadata": "none; source timestamps are naive",
            "source_files": [path.name for path in sorted(SOURCE.glob("*.xlsx"))],
            "csv_files_found": [path.name for path in SOURCE.glob("*.csv")],
            "csv_subfolder_found": (SOURCE / "excel_format").exists(),
            "latest_hourly_capture": max(item["timestamp"] for item in hourly),
            "latest_hourly_arrival": max(item["received_at"] for item in hourly),
        },
        "buildings": buildings,
        "calendar": calendar,
        "daily": daily,
        "hourly": hourly,
        "manual_logs": manuals,
        "relations": relations,
        "source_freshness": "historical workbook replay; never live sensor data",
    }
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "data-audit.md").write_text(make_audit_markdown(audits, relations))
    database_path = build_sqlite(tables, buildings, calendar, daily, hourly, manuals, relations, manifest["benchmark"], audits)

    # Create the two model artifacts from labeled benchmark data and time-aware validation.
    # Import in-process so the workbook engine and shared numeric libraries are
    # loaded once; launching a fresh Python process needlessly repeats the slow
    # openpyxl cold import on some managed desktop runtimes.
    from train_classifier import main as train_classifier_main
    from evaluate_forecast import main as evaluate_forecast_main

    train_classifier_main()
    evaluate_forecast_main()
    print(json.dumps({"database": str(database_path), "written": ["data/campulse.sqlite", "data/waste-model.json", "data/waste-evaluation.json", "data/waste-test-predictions.json", "data/forecast.json", "docs/data-audit.md"], "relations": relations}, indent=2))


if __name__ == "__main__":
    main()
