# Campulse

**The pulse of a resource-smart campus.** Campulse is a responsive operations workspace for campus facilities teams. It brings resource use, data quality, forecasts, waste sorting and ranked evidence into one view.

> **Data status:** the included readings are a synthetic historical benchmark for eight hypothetical buildings (20 June–17 October 2026). They are not Chanakya University sensor measurements. The interface keeps this distinction visible throughout.

## Product capabilities

- Campus overview for electricity, water, waste, diversion and source freshness.
- Interactive resource-grid schematic with selectable benchmark buildings.
- Building history, source trace, operational evidence and 6/12-hour electricity forecasts.
- Six-class smart-bin sensor classification with temporal holdout metrics and CPU inference.
- Ranked anomaly hypotheses with evidence, uncertainty and suggested checks.
- Historical replay and per-browser offline/reconnect simulation.
- Occupant-normalized resource comparison against each building's prior baseline; credits are illustrative and are not issued.
- Data health, workbook traceability and model-method pages.

## Technology stack

| Layer | Implementation |
| --- | --- |
| Interface | Semantic HTML, responsive CSS, browser JavaScript ES modules, inline SVG charts and schematic |
| Application/API | Node.js 22.5+ and native `node:http`; JSON REST endpoints |
| Benchmark store | SQLite via built-in `node:sqlite`; immutable benchmark database separate from mutable session state |
| Data preparation | Python 3.10+, pandas, NumPy and openpyxl |
| Waste classification | Time-ordered model training in Python; dependency-free JavaScript CPU inference in the API |
| Forecast | Time-aware ridge regression with a seasonal-naive comparison and empirical holdout error band |
| Mapping | Illustrative SVG resource network; no geographic basemap or external map key is configured |
| Deployment | Multi-stage Docker image; Docker Compose for local/container hosting |

The interface has no npm runtime dependencies or third-party CDN requests. A structured stack and deployment guide is in [`docs/tech-stack-and-deployment.md`](docs/tech-stack-and-deployment.md).

## Run locally

Requirements: Node.js 22.5 or newer, Python 3.10 or newer, and the seven source workbooks in `P2P_DATASET/`.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-ml.txt
npm run prepare:data
npm start
```

Open <http://127.0.0.1:4173>. Data preparation reads the workbooks without changing them and generates private runtime artifacts in the ignored `data/` directory. `npm start` measures JavaScript inference on the current Node host, then starts the web service. `npm run dev` starts the service with Node watch mode. The server binds to `0.0.0.0` by default so the same command works inside a container.

## Run with Docker

Docker builds benchmark artifacts from the supplied workbooks and runs the Node service. The generated SQLite files are outside the publicly served asset directory.

```sh
docker compose up --build
```

Open <http://127.0.0.1:4173>. Compose keeps the demo session database in a named volume. The container exposes `/api/health` for readiness checks.

## Deploy

The repository includes a multi-stage `Dockerfile` and `compose.yaml`. Push the source to your Git provider, then connect the repository to a container-capable host or build and push the image to your registry. Configure the host to:

1. Build the repository's `Dockerfile`.
2. Route HTTPS traffic to the container's `PORT` (the app binds to `0.0.0.0`).
3. Use `/api/health` as its health-check path.
4. Set `NODE_ENV=production` and, if persistent demo state is needed, mount a single-instance persistent disk at `/var/lib/campulse`.

The public demonstration is designed for one service instance with SQLite session state. For multiple replicas or real campus operations, move mutable state and live readings to a managed database and ingestion service before scaling. Hosting credentials and a deployment provider have not been configured in this workspace.

## Project structure

```text
public/             Responsive web interface and static assets
server.mjs          HTTP server, JSON API, data access and session isolation
lib/classifier.mjs  Dependency-free waste model inference
scripts/            Workbook preparation, model/forecast evaluation and startup
P2P_DATASET/        Read-only source workbooks and supplied requirements
docs/               Data audit, implementation notes, stack and deployment guide
Dockerfile          Reproducible data-build and Node runtime stages
compose.yaml        Local container deployment with persistent demo state
data/               Generated SQLite and model artifacts (ignored by Git)
```

## Source and implementation notes

- [`docs/data-audit.md`](docs/data-audit.md): workbook sheets, fields, units, date coverage, missingness, duplicate keys and normalization.
- [`docs/implementation-notes.md`](docs/implementation-notes.md): campus research, model and forecast results, limitations, offline integrity, incentives, cost, scale and failure mitigation.
- [`docs/tech-stack-and-deployment.md`](docs/tech-stack-and-deployment.md): complete component map, local setup, container build and deployment requirements.
- [`P2P_DATASET/README_data_guide.md`](P2P_DATASET/README_data_guide.md) and [`P2P_DATASET/PROBLEM_STATEMENT_AND_CONSTRAINTS.md`](P2P_DATASET/PROBLEM_STATEMENT_AND_CONSTRAINTS.md): supplied source documentation.

## Deployment boundary

This version is a deployable **benchmark demonstration**, not a live campus operations system. Live meters, verified building geometry, production identity/access controls, and a campus data pipeline remain separate deployment work. Do not describe its values as live readings or map synthetic building IDs onto real campus buildings.
