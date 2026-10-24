FROM python:3.12-slim AS data-build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements-ml.txt

COPY P2P_DATASET/ ./P2P_DATASET/
COPY scripts/ ./scripts/
COPY docs/ ./docs/
RUN python3 scripts/prepare_data.py

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4173 \
    CAMPULSE_STATE_DB=/var/lib/campulse/state.sqlite

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/start.mjs ./scripts/start.mjs
COPY scripts/benchmark_inference.mjs ./scripts/benchmark_inference.mjs
COPY --from=data-build --chown=node:node /app/data/ ./data/
RUN mkdir -p /var/lib/campulse && chown node:node /var/lib/campulse

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
