import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { classifyWaste } from "./lib/classifier.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "campulse.sqlite");
const stateDbPath = process.env.CAMPULSE_STATE_DB
  ? path.resolve(process.env.CAMPULSE_STATE_DB)
  : path.join(dataDir, "campulse-state.sqlite");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const sessionCookie = "campulse_session";
const sessionLifetimeDays = 30;
let requestCount = 0;

if (!fs.existsSync(dbPath)) {
  process.stderr.write("Campulse data is missing. Run `python3 scripts/prepare_data.py` first.\n");
  process.exit(1);
}
if (stateDbPath === dbPath) {
  process.stderr.write("CAMPULSE_STATE_DB must point to a file separate from the read-only benchmark database.\n");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA query_only=ON;");
fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
const stateDb = new DatabaseSync(stateDbPath);
stateDb.exec(`PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS demo_sessions (session_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS demo_offline (session_id TEXT NOT NULL, building_id TEXT NOT NULL,
    since_cursor TEXT NOT NULL, last_advance_cursor TEXT NOT NULL, PRIMARY KEY(session_id, building_id));
  CREATE TABLE IF NOT EXISTS demo_queue (session_id TEXT NOT NULL, record_key TEXT NOT NULL, building_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, received_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    deduplicated_rows INTEGER NOT NULL DEFAULT 0, synced_at TEXT, PRIMARY KEY(session_id, record_key));
  CREATE INDEX IF NOT EXISTS demo_queue_status_idx ON demo_queue(session_id, building_id, synced_at);
  CREATE TABLE IF NOT EXISTS demo_sync_log (sync_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    building_id TEXT NOT NULL, cursor TEXT NOT NULL, queued_rows INTEGER NOT NULL,
    deduplicated_rows INTEGER NOT NULL, reconciliation_key TEXT NOT NULL);`);
const model = JSON.parse(fs.readFileSync(path.join(dataDir, "waste-model.json"), "utf8"));
const wasteEvaluation = JSON.parse(fs.readFileSync(path.join(dataDir, "waste-evaluation.json"), "utf8"));
const wastePreview = JSON.parse(fs.readFileSync(path.join(dataDir, "waste-test-predictions.json"), "utf8"));
const forecast = JSON.parse(fs.readFileSync(path.join(dataDir, "forecast.json"), "utf8"));
const inferenceBenchmarkPath = path.join(dataDir, "waste-inference-benchmark.json");
const inferenceBenchmark = fs.existsSync(inferenceBenchmarkPath) ? JSON.parse(fs.readFileSync(inferenceBenchmarkPath, "utf8")) : null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function tableRows(table, orderBy) {
  const sql = `SELECT payload_json FROM ${table} ORDER BY ${orderBy}`;
  return db.prepare(sql).all().map((row) => JSON.parse(row.payload_json));
}

function dataPayload() {
  const metadata = Object.fromEntries(
    db.prepare("SELECT key, value_json FROM dataset_meta").all().map((row) => [row.key, JSON.parse(row.value_json)]),
  );
  return {
    benchmark: metadata.benchmark,
    relations: metadata.relations,
    sources: metadata.sources,
    sourceFreshness: "Historical workbook replay. This is not a live campus feed.",
    buildings: tableRows("buildings", "building_id"),
    calendar: tableRows("calendar", "date"),
    daily: tableRows("daily", "date, building_id"),
    hourly: tableRows("hourly", "timestamp, building_id"),
    manualLogs: tableRows("manual_logs", "logged_at, log_id"),
  };
}

function demoStatus(sessionId) {
  const offline = stateDb.prepare("SELECT building_id, since_cursor, last_advance_cursor FROM demo_offline WHERE session_id=? ORDER BY building_id").all(sessionId);
  const queued = stateDb.prepare("SELECT building_id, COUNT(*) AS count, MIN(timestamp) AS first_capture, MAX(timestamp) AS last_capture FROM demo_queue WHERE session_id=? AND synced_at IS NULL GROUP BY building_id").all(sessionId);
  const lastSync = stateDb.prepare("SELECT building_id, cursor, queued_rows, deduplicated_rows FROM demo_sync_log WHERE session_id=? ORDER BY sync_id DESC").all(sessionId);
  return { offline, queued, lastSync };
}

function ensureDemoSession(req, res) {
  const cookieHeader = req.headers.cookie || "";
  const existing = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  let sessionId = existing?.slice(sessionCookie.length + 1) || "";
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId)) {
    sessionId = randomUUID();
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = process.env.NODE_ENV === "production" && (req.socket.encrypted || forwardedProtocol === "https") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${sessionCookie}=${sessionId}; Path=/; Max-Age=${sessionLifetimeDays * 86400}; HttpOnly; SameSite=Lax${secure}`);
  }

  stateDb.prepare(`INSERT INTO demo_sessions(session_id, last_seen_at) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(sessionId, new Date().toISOString());
  requestCount += 1;
  if (requestCount % 250 === 0) pruneExpiredSessions();
  return sessionId;
}

function pruneExpiredSessions() {
  const cutoff = new Date(Date.now() - sessionLifetimeDays * 86400 * 1000).toISOString();
  const stale = stateDb.prepare("SELECT session_id FROM demo_sessions WHERE last_seen_at < ?").all(cutoff);
  if (!stale.length) return;
  stateDb.exec("BEGIN IMMEDIATE");
  try {
    for (const { session_id: sessionId } of stale) {
      stateDb.prepare("DELETE FROM demo_offline WHERE session_id=?").run(sessionId);
      stateDb.prepare("DELETE FROM demo_queue WHERE session_id=?").run(sessionId);
      stateDb.prepare("DELETE FROM demo_sync_log WHERE session_id=?").run(sessionId);
      stateDb.prepare("DELETE FROM demo_sessions WHERE session_id=?").run(sessionId);
    }
    stateDb.exec("COMMIT");
  } catch (error) {
    stateDb.exec("ROLLBACK");
    throw error;
  }
}

function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const requestProtocol = forwardedProtocol || (req.socket.encrypted ? "https" : "http");
    return parsed.host === req.headers.host && parsed.protocol === `${requestProtocol}:`;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validCursor(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function queueRowsForOfflineBuildings(cursor, sessionId) {
  if (!validCursor(cursor)) throw new Error("Replay cursor is invalid.");
  const offline = stateDb.prepare("SELECT building_id, since_cursor, last_advance_cursor FROM demo_offline WHERE session_id=?").all(sessionId);
  const select = db.prepare(`SELECT building_id, timestamp, received_at, payload_json, source_count
    FROM hourly WHERE building_id = ? AND datetime(received_at) > datetime(?) AND datetime(received_at) <= datetime(?) ORDER BY datetime(received_at), datetime(timestamp)`);
  const upsert = stateDb.prepare(`INSERT INTO demo_queue(session_id, record_key, building_id, timestamp, received_at, payload_json, deduplicated_rows, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(session_id, record_key) DO UPDATE SET received_at=excluded.received_at, payload_json=excluded.payload_json,
      deduplicated_rows=excluded.deduplicated_rows
    WHERE excluded.received_at > demo_queue.received_at`);
  let queued = 0;
  let deduplicated = 0;
  stateDb.exec("BEGIN IMMEDIATE");
  try {
    for (const item of offline) {
      let effectiveCursor = item.last_advance_cursor;
      if (Date.parse(cursor) < Date.parse(item.last_advance_cursor)) {
        stateDb.prepare("DELETE FROM demo_queue WHERE session_id=? AND building_id=? AND synced_at IS NULL").run(sessionId, item.building_id);
        stateDb.prepare("UPDATE demo_offline SET since_cursor=?, last_advance_cursor=? WHERE session_id=? AND building_id=?").run(cursor, cursor, sessionId, item.building_id);
        effectiveCursor = cursor;
      }
      const rows = select.all(item.building_id, effectiveCursor, cursor);
      for (const row of rows) {
        const key = `${row.building_id}\t${row.timestamp}`;
        const prior = stateDb.prepare("SELECT 1 FROM demo_queue WHERE session_id=? AND record_key=?").get(sessionId, key);
        upsert.run(sessionId, key, row.building_id, row.timestamp, row.received_at, row.payload_json, Math.max(0, row.source_count - 1));
        if (!prior) queued += 1;
        if (!prior) deduplicated += Math.max(0, row.source_count - 1);
      }
      stateDb.prepare("UPDATE demo_offline SET last_advance_cursor=? WHERE session_id=? AND building_id=?").run(cursor, sessionId, item.building_id);
    }
    stateDb.exec("COMMIT");
  } catch (error) {
    stateDb.exec("ROLLBACK");
    throw error;
  }
  return { queued, deduplicated, state: demoStatus(sessionId) };
}

function staticFile(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const requestPath = decoded === "/" ? "/index.html" : decoded;
  if (/\.(?:sqlite|db|wal|shm)$/i.test(requestPath)) return json(res, 404, { error: "Asset not found." });
  const resolved = path.resolve(publicDir, `.${requestPath}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) return json(res, 403, { error: "Path is not allowed." });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return json(res, 404, { error: "Page or asset not found." });
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    ...securityHeaders,
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": [".html", ".js", ".css"].includes(ext) ? "no-store" : "public, max-age=300",
  });
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const usesDemoSession = url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/api/demo/");
    const sessionId = usesDemoSession ? ensureDemoSession(req, res) : null;
    if (req.method === "POST" && !sameOriginRequest(req)) return json(res, 403, { error: "This request must come from the Campulse site." });
    if (req.method === "GET" && url.pathname === "/api/health") {
      const counts = Object.fromEntries(["buildings", "calendar", "daily", "hourly", "manual_logs", "source_rows"].map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n]));
      return json(res, 200, { status: "ready", database: "SQLite benchmark data and isolated session state", counts, dataMode: "synthetic benchmark replay" });
    }
    if (req.method === "GET" && url.pathname === "/api/data") return json(res, 200, dataPayload());
    if (req.method === "GET" && url.pathname === "/api/models/waste") return json(res, 200, { model: { ...model, trees: undefined }, evaluation: wasteEvaluation, testPreview: wastePreview, benchmark: inferenceBenchmark });
    if (req.method === "GET" && url.pathname === "/api/models/forecast") return json(res, 200, forecast);
    if (req.method === "GET" && url.pathname === "/api/demo/state") return json(res, 200, demoStatus(sessionId));
    if (req.method === "GET" && url.pathname === "/api/source") {
      const file = url.searchParams.get("file");
      const sheet = url.searchParams.get("sheet");
      const row = Number(url.searchParams.get("row"));
      const result = db.prepare("SELECT payload_json FROM source_rows WHERE source_file=? AND source_sheet=? AND source_row=?").get(file, sheet, row);
      return result ? json(res, 200, { sourceFile: file, sourceSheet: sheet, sourceRow: row, values: JSON.parse(result.payload_json) }) : json(res, 404, { error: "Source row not found." });
    }
    if (req.method === "POST" && url.pathname === "/api/classify") {
      const body = await readBody(req);
      const supplied = body.features && typeof body.features === "object" ? body.features : body;
      const usable = model.features.some((name) => Number.isFinite(supplied[name]));
      if (!usable) return json(res, 400, { error: "Enter at least one finite sensor reading." });
      if (model.features.some((name) => supplied[name] !== undefined && supplied[name] !== null && !Number.isFinite(supplied[name]))) return json(res, 400, { error: "Sensor values must be numbers or left blank." });
      return json(res, 200, classifyWaste(model, supplied));
    }
    if (req.method === "POST" && url.pathname === "/api/demo/offline") {
      const body = await readBody(req);
      const buildingId = String(body.buildingId || "");
      if (!/^B0[1-8]$/.test(buildingId) || !validCursor(body.cursor)) return json(res, 400, { error: "Choose a benchmark building and a valid replay time." });
      stateDb.prepare(`INSERT INTO demo_offline(session_id, building_id, since_cursor, last_advance_cursor) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, building_id) DO NOTHING`).run(sessionId, buildingId, body.cursor, body.cursor);
      return json(res, 200, { state: demoStatus(sessionId) });
    }
    if (req.method === "POST" && url.pathname === "/api/demo/advance") {
      const body = await readBody(req);
      return json(res, 200, queueRowsForOfflineBuildings(body.cursor, sessionId));
    }
    if (req.method === "POST" && url.pathname === "/api/demo/reconnect") {
      const body = await readBody(req);
      const buildingId = String(body.buildingId || "");
      if (!/^B0[1-8]$/.test(buildingId) || !validCursor(body.cursor)) return json(res, 400, { error: "Choose a benchmark building and a valid replay time." });
      stateDb.exec("BEGIN IMMEDIATE");
      let queuedRows = 0;
      try {
        queuedRows = stateDb.prepare("SELECT COUNT(*) AS n FROM demo_queue WHERE session_id=? AND building_id=? AND synced_at IS NULL").get(sessionId, buildingId).n;
        const duplicates = stateDb.prepare("SELECT COALESCE(SUM(deduplicated_rows),0) AS n FROM demo_queue WHERE session_id=? AND building_id=? AND synced_at IS NULL").get(sessionId, buildingId).n;
        stateDb.prepare("UPDATE demo_queue SET synced_at=? WHERE session_id=? AND building_id=? AND synced_at IS NULL").run(body.cursor, sessionId, buildingId);
        stateDb.prepare("DELETE FROM demo_offline WHERE session_id=? AND building_id=?").run(sessionId, buildingId);
        stateDb.prepare("INSERT INTO demo_sync_log(session_id,building_id,cursor,queued_rows,deduplicated_rows,reconciliation_key) VALUES (?,?,?,?,?,?)")
          .run(sessionId, buildingId, body.cursor, queuedRows, duplicates, "building_id + capture timestamp; latest received_at wins");
        stateDb.exec("COMMIT");
      } catch (error) {
        stateDb.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { buildingId, reconciledRows: queuedRows, deduplicatedRows: stateDb.prepare("SELECT deduplicated_rows AS n FROM demo_sync_log WHERE session_id=? ORDER BY sync_id DESC LIMIT 1").get(sessionId).n, state: demoStatus(sessionId) });
    }
    if (req.method === "POST" && url.pathname === "/api/demo/reset") {
      stateDb.prepare("DELETE FROM demo_offline WHERE session_id=?").run(sessionId);
      stateDb.prepare("DELETE FROM demo_queue WHERE session_id=?").run(sessionId);
      stateDb.prepare("DELETE FROM demo_sync_log WHERE session_id=?").run(sessionId);
      return json(res, 200, { state: demoStatus(sessionId) });
    }
    if (req.method === "GET") return staticFile(req, res, url.pathname);
    return json(res, 405, { error: "Method is not supported." });
  } catch (error) {
    process.stderr.write(`[Campulse request error] ${error.stack || error.message}\n`);
    return json(res, 500, { error: "Campulse could not complete this request." });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Campulse is listening on ${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      stateDb.close();
      process.exit(0);
    });
  });
}
