# Campulse stack and deployment guide

Checked 24 October 2026. This document describes the implementation in this repository, distinguishes it from the future production architecture, and gives a repeatable path to a public benchmark demonstration.

## 1. Current implementation

| Concern | Technology | What runs here |
| --- | --- | --- |
| User interface | HTML, CSS, browser ES modules | Responsive accessible navigation, resource cards, tabular evidence, inline SVG charts and the interactive schematic |
| Web/API service | Node.js 22.5+ (`node:http`) | Serves the interface and JSON endpoints from one process; binds to `0.0.0.0` and honors `PORT` |
| Benchmark database | SQLite (`node:sqlite`) | Read-only workbook-derived records and source trace; stored under `data/`, outside the public asset directory |
| Browser-session state | A separate SQLite file | Per-browser replay outage queue, reconnect log and reset state; path configurable with `CAMPULSE_STATE_DB` |
| Data preparation | Python 3.10+, pandas, NumPy, openpyxl | Reads the seven Excel workbooks, audits quality, normalizes records, and writes SQLite/model artifacts |
| Waste classifier | Python training/evaluation, JavaScript inference | A small sensor-feature forest is evaluated chronologically; one dependency-free JS classifier serves browser requests through the API |
| Forecast | Python training/evaluation | Ridge regression forecasts electricity at 6 and 12 hours, compared with a same-hour-yesterday baseline |
| Visualization | Native SVG, HTML and CSS | No chart, UI or mapping framework; no geographic basemap or external map key is configured |
| Runtime packaging | Docker multi-stage build and Compose | Python builds derived artifacts; a Node-only runtime serves the app. Compose persists only browser-session simulation state. |

There is no React, Next.js, FastAPI, MQTT broker, production PostgreSQL service, camera pipeline, external analytics SDK, or map API integration in this version. The UI has no npm runtime packages and does not load scripts, fonts or styles from a CDN.

## 2. Data and runtime layout

```text
P2P_DATASET/*.xlsx             Read-only source workbooks
scripts/prepare_data.py        Audit, normalize, fuse, and build SQLite
scripts/train_classifier.py    Time-ordered evaluation and model fit
scripts/evaluate_forecast.py   Time-aware forecast evaluation and artifacts
scripts/benchmark_inference.mjs Measure the shipped JavaScript model on this Node host
data/campulse.sqlite            Generated benchmark records and workbook trace
data/waste-model.json           Generated classifier model
data/waste-evaluation.json      Temporal holdout report and confusion matrix
data/waste-test-predictions.json Predictions for unlabelled test events
data/forecast.json              Forecast model and holdout report
data/campulse-state.sqlite      Browser-scoped demonstration state (default path)
public/                         Static web interface; contains no SQLite database
```

All generated `data/` files are ignored by Git. The source workbooks remain unchanged. The Docker build regenerates artifacts from `P2P_DATASET/`; local setup does the same with `npm run prepare:data`.

The benchmark database opens in SQLite query-only mode. Demo state lives separately and is associated with an opaque HTTP-only, same-site cookie. Each browser's offline simulation and reset actions are isolated; sessions idle for more than 30 days are removed during periodic cleanup. The container can use a persistent disk for that state file without hiding the packaged benchmark data.

## 3. Local setup

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-ml.txt
npm run prepare:data
npm start
```

Open <http://127.0.0.1:4173>. `npm start` measures classification latency on the Node host before starting the HTTP server. The service exposes `/api/health` for readiness and uses no credentials or third-party runtime service.

For UI changes, `npm run dev` starts the Node server with watch mode. If data artifacts were removed, rerun `npm run prepare:data` before starting.

## 4. Docker build and local container

Build and run with Docker Compose:

```sh
docker compose up --build
```

Compose publishes port `4173`, sets production cookie behavior, and mounts a named volume for `/var/lib/campulse/state.sqlite`. The service's health check is `GET /api/health`. Stop it with `Ctrl-C`; the Compose volume remains so replay state survives a container rebuild.

To build and run the image directly:

```sh
docker build -t campulse:local .
docker run --rm -p 4173:4173 campulse:local
```

Without a mounted volume, demo state is ephemeral and resets when the container is replaced. The source workbooks are included in the build context because they are required to reproduce the synthetic benchmark artifacts.

## 5. Push and cloud deployment

The local repository is initialized on `main` with the Campulse source and deployment files committed. No remote or hosting provider is configured. When you have a repository URL, connect it and push:

```sh
git remote add origin <repository-url>
git push -u origin main
```

If `origin` is already set, update it with `git remote set-url origin <repository-url>` before pushing.

Connect the repository to a host that builds Dockerfiles, or build and push `campulse:local` to an OCI-compatible registry. Configure the web service with:

| Setting | Value |
| --- | --- |
| Build | Repository `Dockerfile` |
| Start | Container default (`npm start`) |
| Port | The host-provided `PORT`; default `4173` locally |
| Health check | `/api/health` |
| Environment | `NODE_ENV=production` |
| Persistent disk | Mount at `/var/lib/campulse` if replay state should survive replacement |
| TLS | Terminate HTTPS at the hosting platform or trusted reverse proxy |
| Secrets | None required by this build; do not add the previously shared CARTO key because no map request is made |

Use a single app instance while demo state is SQLite-backed. Do not turn on horizontal replicas: separate local files would produce inconsistent state across instances. The current app is suitable for a public benchmark demonstration, not authenticated campus operations. For a real multi-building deployment, first introduce campus identity and roles, permissioned ingestion, a managed PostgreSQL/time-series store, retention/backups, operational monitoring, and a verified device registry. A public host URL cannot be created from this workspace because no host, domain or account credentials were supplied.

## 6. HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Readiness and benchmark table counts |
| `GET /api/data` | Fused benchmark records and source metadata |
| `GET /api/source` | Original workbook row lookup for traceability |
| `GET /api/models/waste` | Classifier, temporal evaluation and prediction-only test preview |
| `GET /api/models/forecast` | Forecast values and time-aware evaluation report |
| `POST /api/classify` | CPU classification for supplied sensor features |
| `GET/POST /api/demo/*` | Browser-scoped benchmark replay and offline/reconnect simulation |

The HTTP service adds same-origin checks for browser POST requests, same-site session cookies, content-type/frame/referrer protections, a restrictive Content Security Policy, and generic client-facing 500 responses. These controls reduce exposure for a demonstration; they do not replace authentication, authorization or a security review for real operational data.

## 7. Deployment readiness and limits

**Ready for a public demo:** responsive interface, repeatable data build, source trace, health endpoint, portable container, HTTPS-compatible host binding, per-browser replay state, ignored runtime artifacts, no hard-coded secrets, and visible historical/synthetic data labels.

**Not a live campus service:** there are no Chanakya University sensor feeds or credentials, verified georeferenced building footprints, real asset-to-building crosswalk, authenticated operator roles, live alert delivery, production database, or calibrated campus forecasting/classification. Keep those labels and limits in the interface until the matching system is actually connected and validated.

The SVG campus view is an illustrative resource network. A CARTO map can be added separately after the basemap key is rotated/restricted and the University supplies or confirms georeferenced campus geometry. Do not overlay synthetic B01–B08 records on real building footprints.
