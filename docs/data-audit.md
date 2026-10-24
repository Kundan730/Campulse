# Dataset inspection

Source workbooks were opened read-only. The application consumes the workbook sheets directly through `scripts/prepare_data.py`; the source files remain unchanged.

## Workbook coverage

| Workbook and sheet | Rows × columns | Date range | Missing values | Duplicate rows / keys |
|---|---:|---|---|---|
| `buildings.xlsx` · `buildings` | 8 × 10 | static table | none | 0 exact / 0 key |
| `calendar.xlsx` · `calendar` | 120 × 7 | date: 2026-06-20T00:00:00 to 2026-10-17T00:00:00 | event 73 | 0 exact / 0 key |
| `daily_summary.xlsx` · `daily_summary` | 960 × 14 | date: 2026-06-20T00:00:00 to 2026-10-17T00:00:00 | occupancy_avg 5, electricity_kwh 11, water_litres 11, wet_organic_kg 9 | 0 exact / 0 key |
| `hourly_streams.xlsx` · `hourly_streams` | 23192 × 7 | timestamp: 2026-06-20T00:00:00 to 2026-10-17T23:00:00, received_at: 2026-06-20T01:01:00 to 2026-10-18T07:01:00 | electricity_kwh 69, water_litres 69, footfall 69 | 0 exact / 184 key |
| `manual_logs.xlsx` · `manual_logs` | 415 × 8 | logged_at: 2026-06-20T18:10:00 to 2026-10-17T19:00:00 | value 13, unit 13, note 148 | 0 exact / 0 key |
| `waste_events_train.xlsx` · `waste_events_train` | 6314 × 10 | timestamp: 2026-06-20T04:36:28 to 2026-10-17T23:55:44 | weight_g 127, moisture_pct 129, metal_signal 125, transparency 116, acoustic_hardness 123 | 0 exact / 0 key |
| `waste_events_test.xlsx` · `waste_events_test` | 1601 × 9 | timestamp: 2026-06-20T10:38:58 to 2026-10-17T21:47:54 | weight_g 31, moisture_pct 29, metal_signal 33, transparency 42, acoustic_hardness 35 | 0 exact / 0 key |

## Fields, units, and types

### `buildings.xlsx` / `buildings`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `building_id` | object | synthetic primary key |
| `building_name` | object | synthetic benchmark label, not a Chanakya University mapping |
| `building_type` | object | synthetic benchmark type |
| `floors` | int64 | count, hypothetical metadata |
| `area_sqm` | int64 | m², hypothetical metadata |
| `design_capacity` | int64 | persons, hypothetical metadata |
| `has_solar` | int64 | boolean-like 0/1 |
| `solar_capacity_kw` | int64 | kW, hypothetical metadata |
| `year_built` | int64 | year, hypothetical metadata |
| `has_composter` | int64 | boolean-like 0/1 |

### `calendar.xlsx` / `calendar`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `date` | object | local date |
| `day_of_week` | object | weekday label |
| `day_type` | object | synthetic schedule category |
| `event` | object | optional event description |
| `avg_temp_c` | float64 | °C, daily mean |
| `rainfall_mm` | float64 | mm, daily total |
| `humidity_pct` | int64 | % |

### `daily_summary.xlsx` / `daily_summary`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `date` | object | local date |
| `building_id` | object | synthetic building key |
| `occupancy_avg` | float64 | estimated people/day |
| `electricity_kwh` | float64 | kWh/day |
| `water_litres` | float64 | L/day |
| `solar_generation_kwh` | float64 | kWh/day |
| `wet_organic_kg` | float64 | kg/day |
| `dry_recyclable_kg` | float64 | kg/day |
| `ewaste_kg` | float64 | kg/day |
| `hazardous_kg` | float64 | kg/day |
| `composted_kg` | float64 | kg/day diverted |
| `recycled_kg` | float64 | kg/day diverted |
| `contamination_pct` | float64 | % |
| `landfill_kg` | float64 | kg/day |

### `hourly_streams.xlsx` / `hourly_streams`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `timestamp` | object | capture local timestamp |
| `received_at` | object | server arrival local timestamp |
| `building_id` | object | synthetic building key |
| `electricity_kwh` | float64 | kWh per hour |
| `water_litres` | float64 | L per hour |
| `solar_generation_kwh` | float64 | kWh per hour |
| `footfall` | float64 | turnstile passages/hour |

### `manual_logs.xlsx` / `manual_logs`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `log_id` | object | unique manual log ID |
| `logged_at` | object | operator entry local timestamp |
| `logger_role` | object | operator role |
| `building` | object | free-text building alias |
| `stream` | object | electricity / water / waste / note |
| `value` | float64 | number, interpreted with unit |
| `unit` | object | kWh / units / L / kL / kg / bags |
| `note` | object | free-text observation |

### `waste_events_train.xlsx` / `waste_events_train`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `event_id` | object | unique event ID |
| `timestamp` | object | capture local timestamp |
| `building_id` | object | synthetic building key |
| `bin_id` | object | synthetic bin key |
| `weight_g` | float64 | g |
| `moisture_pct` | float64 | % |
| `metal_signal` | float64 | sensor response, unitless |
| `transparency` | float64 | unitless coefficient 0–1 |
| `acoustic_hardness` | float64 | unitless coefficient 0–1 |
| `category` | object | six-class label |

### `waste_events_test.xlsx` / `waste_events_test`

| Field | Workbook type | Meaning / unit |
|---|---|---|
| `event_id` | object | unique event ID |
| `timestamp` | object | capture local timestamp |
| `building_id` | object | synthetic building key |
| `bin_id` | object | synthetic bin key |
| `weight_g` | float64 | g |
| `moisture_pct` | float64 | % |
| `metal_signal` | float64 | sensor response, unitless |
| `transparency` | float64 | unitless coefficient 0–1 |
| `acoustic_hardness` | float64 | unitless coefficient 0–1 |

## Relationships and quality findings

- The buildings master has 8 unique IDs. Daily summaries contain 960 unique `(date, building_id)` keys, exactly 960 expected keys. Hourly capture data contains 23008 unique `(building_id, timestamp)` keys of 23040 expected; 32 expected keys are absent and 184 capture keys have retransmissions. 184 duplicate groups contain differing readings.
- A retrospective, same-hour-of-day robust check flagged 116 possible noisy hourly values; values were retained without smoothing. A production detector must use past-only history.
- All manual aliases mapped: 415 / 415. Logs are normalized for joining, but they never overwrite the hourly or daily telemetry. The source log ID remains the idempotency key. Repeated readings within 30 minutes are flagged for review.
- Calendar and daily summaries share the 120-day range. Both labeled and unlabelled waste event tables refer to the same eight benchmark IDs. The unlabelled table has no target column and is used only for predictions.
- The guide names `waste_class`; the actual training workbook uses `category`. Training uses the workbook column. There are no CSV files or `excel_format/` subfolder in the supplied directory; only the seven top-level `.xlsx` workbooks are present.
- Excel timestamps have no timezone metadata. The demo preserves their naive local-time representation and does not silently convert them. Campus operations are expected to be in IST; confirm device time zones before real ingestion.
- Hourly values and daily summaries are separate grains. Daily dashboard totals use `daily_summary`; hourly charts use `hourly_streams`. They are not added together. Missing numeric cells remain null and are displayed as unavailable rather than zero.
- Waste mass total uses `composted_kg + recycled_kg + landfill_kg` to avoid counting category totals and diverted mass twice. Category mass is still available separately. The benchmark's mass-balance relation has high correlation but small rounding and occasional larger differences, so category sums are not forced to equal the disposal total.

## Normalization rules

- Manual aliases map the dataset's eight synthetic building labels to B01–B08 using a fixed, auditable alias table in `scripts/prepare_data.py`.
- `units` and `kWh` become kWh; `kL` becomes 1,000 L; `L` stays L; `bags` become an approximate 8 kg per bag; `kg` stays kg. Original value and unit are retained beside the normalized value.
- Hourly retransmissions are grouped by `(building_id, timestamp)`. Winner is the row with the most nonmissing measurements, then latest `received_at`, then greatest workbook row number. Every selected source row and duplicate revision is retained in the processed data, with flags.
- Hourly values beyond eight scaled median absolute deviations from their building/channel/hour-of-day group are flagged as possible spikes. This retrospective full-window audit does not claim causality or replace a streaming past-only detector.
- A delay over two hours is flagged; over six hours is severe. Capture time (`timestamp`) and server arrival (`received_at`) are separate fields. Replay availability follows arrival time.
