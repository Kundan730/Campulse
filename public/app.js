const $ = (id) => document.getElementById(id);
const byClass = (name) => document.querySelectorAll(name);
const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const integerFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const HOUR = 60 * 60 * 1000;

const app = {
  data: null,
  waste: null,
  forecast: null,
  health: null,
  demo: { offline: [], queued: [], lastSync: [] },
  timeline: [],
  cursorIndex: 0,
  selectedBuilding: "B01",
  activeView: "overview",
  playing: false,
  timer: null,
  advanceTimer: null,
  selectedWasteClass: "all",
  campusResource: "electricity_kwh",
  alerts: [],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function fmtNumber(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Unavailable";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value));
}

function fmtCompact(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}m`;
  if (Math.abs(amount) >= 10_000) return `${(amount / 1_000).toFixed(1)}k`;
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(2)}k`;
  return fmtNumber(amount, 1);
}

function fmtPercent(value, digits = 0) {
  return Number.isFinite(Number(value)) ? `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(Number(value))}%` : "Unavailable";
}

function dateKey(value) {
  return String(value ?? "").slice(0, 10);
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-IN", options).format(date);
}

function formatDateTime(value, options = {}) {
  const date = asDate(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...options }).format(date);
}

function toNaiveIsoHour(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:00:00`;
}

function captureHourKey(value) {
  const date = asDate(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:00`;
}

function floorHour(value) {
  const date = asDate(value);
  date.setMinutes(0, 0, 0);
  return date;
}

function shiftHour(value, amount) {
  const date = asDate(value);
  date.setHours(date.getHours() + amount);
  return date;
}

function labelBuilding(buildingId) {
  const building = app.data?.buildings.find((item) => item.building_id === buildingId);
  return building ? building.building_name : buildingId;
}

function buildingById(buildingId) {
  return app.data?.buildings.find((item) => item.building_id === buildingId) ?? null;
}

function dayByBuilding(buildingId, day) {
  return app.data?.daily.find((row) => row.building_id === buildingId && dateKey(row.date) === day) ?? null;
}

function calendarByDate(day) {
  return app.data?.calendar.find((row) => dateKey(row.date) === day) ?? null;
}

function currentCursor() {
  return app.timeline[app.cursorIndex] ?? app.timeline.at(-1) ?? "2026-10-18T08:00:00";
}

function cursorDate() {
  return dateKey(currentCursor());
}

function visibleHourRows(buildingId = null) {
  const cursor = currentCursor();
  const offline = app.demo.offline.find((item) => item.building_id === buildingId);
  const through = offline ? offline.since_cursor : cursor;
  const throughMs = Date.parse(through);
  const cursorMs = Date.parse(cursor);
  return app.data.hourly.filter((row) =>
    (!buildingId || row.building_id === buildingId) &&
    Date.parse(row.received_at) <= throughMs &&
    Date.parse(row.timestamp) <= cursorMs,
  );
}

function latestAvailable(buildingId) {
  const rows = visibleHourRows(buildingId);
  return rows.length ? rows.reduce((latest, row) => Date.parse(row.received_at) > Date.parse(latest.received_at) ? row : latest) : null;
}

function freshnessFor(buildingId) {
  const record = latestAvailable(buildingId);
  const offline = app.demo.offline.find((item) => item.building_id === buildingId);
  const queued = app.demo.queued.find((item) => item.building_id === buildingId)?.count ?? 0;
  if (offline) return { record, status: "offline", label: queued ? `Offline · ${integerFormat.format(queued)} queued` : "Offline", lagHours: null, queued };
  if (!record) return { record: null, status: "missing", label: "No arrived reading", lagHours: null, queued: 0 };
  const lagHours = Math.max(0, (Date.parse(currentCursor()) - Date.parse(record.received_at)) / HOUR);
  if (lagHours > 6) return { record, status: "stale", label: "Stale · >6 h", lagHours, queued: 0 };
  if (lagHours > 3) return { record, status: "delayed", label: `Delayed · ${fmtNumber(lagHours)} h`, lagHours, queued: 0 };
  return { record, status: "recent", label: `Recent · ${fmtNumber(lagHours)} h`, lagHours, queued: 0 };
}

function statusDotClass(status) {
  return status === "recent" ? "is-green" : status === "delayed" || status === "stale" ? "is-amber" : status === "offline" ? "is-red" : "is-gray";
}

function completedDailyRows() {
  return app.data.daily.filter((row) => dateKey(row.date) < cursorDate());
}

function latestCompletedDay() {
  const days = completedDailyRows().map((row) => dateKey(row.date)).sort();
  return days.at(-1) ?? null;
}

function valueSum(rows, selector, expected = 8) {
  const values = rows.map(selector).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  return { value: values.length === expected ? values.reduce((sum, value) => sum + Number(value), 0) : null, available: values.length, expected };
}

function dailyWaste(row) {
  const pieces = [row?.composted_kg, row?.recycled_kg, row?.landfill_kg];
  return pieces.every((value) => value !== null && value !== undefined && Number.isFinite(Number(value))) ? Number(pieces[0]) + Number(pieces[1]) + Number(pieces[2]) : null;
}

function diversionPercent(row) {
  const diverted = Number(row?.composted_kg) + Number(row?.recycled_kg);
  const total = diverted + Number(row?.landfill_kg);
  return row && [row.composted_kg, row.recycled_kg, row.landfill_kg].every((value) => value !== null && value !== undefined) && total > 0 ? 100 * diverted / total : null;
}

function sourceTimestampSort(a, b) {
  return a.timestamp.localeCompare(b.timestamp);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function setView(viewName) {
  if (!$("view-" + viewName)) return;
  app.activeView = viewName;
  byClass(".view").forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.classList.toggle("is-visible", active);
    view.hidden = !active;
  });
  byClass(".nav-item").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  window.history.replaceState(null, "", `#${viewName}`);
  renderAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initTimeline() {
  const arrivals = app.data.hourly.map((row) => row.received_at).sort();
  const first = floorHour(arrivals[0]);
  const last = floorHour(arrivals.at(-1));
  last.setHours(last.getHours() + 1);
  for (let time = first.getTime(); time <= last.getTime(); time += HOUR) app.timeline.push(toNaiveIsoHour(new Date(time)));
  app.cursorIndex = app.timeline.length - 1;
  const slider = $("playback-slider");
  slider.min = "0";
  slider.max = String(Math.max(0, app.timeline.length - 1));
  slider.value = String(app.cursorIndex);
  $("range-start").textContent = formatDate(app.timeline[0]);
  $("range-end").textContent = formatDate(app.timeline.at(-1));
}

function updateCursor(index, fromInput = false) {
  const next = Math.max(0, Math.min(app.timeline.length - 1, Number(index)));
  const previous = app.cursorIndex;
  app.cursorIndex = next;
  $("playback-slider").value = String(next);
  $("replay-time").textContent = formatDateTime(currentCursor(), { year: "numeric", timeZoneName: undefined });
  if (fromInput && next !== previous) {
    clearTimeout(app.advanceTimer);
  app.advanceTimer = setTimeout(() => advanceOfflineQueue(), 50);
  }
  renderAll();
}

async function advanceOfflineQueue() {
  try {
    const result = await api("/api/demo/advance", { method: "POST", body: JSON.stringify({ cursor: currentCursor() }) });
    app.demo = result.state;
    renderAll();
  } catch (error) {
    setToast(`Replay queue could not advance: ${error.message}`, "error");
  }
}

function togglePlayback() {
  app.playing = !app.playing;
  if (!app.playing) {
    clearInterval(app.timer);
    app.timer = null;
  } else {
    if (app.cursorIndex >= app.timeline.length - 1) updateCursor(0, true);
    startPlaybackTimer();
  }
  updatePlayButton();
}

function startPlaybackTimer() {
  clearInterval(app.timer);
  if (!app.playing) return;
  const speed = Number($("speed-select").value) || 1;
  app.timer = setInterval(() => {
    if (app.cursorIndex >= app.timeline.length - 1) {
      app.playing = false;
      clearInterval(app.timer);
      app.timer = null;
      updatePlayButton();
      return;
    }
    updateCursor(app.cursorIndex + 1, true);
  }, Math.max(65, 1000 / speed));
}

function updatePlayButton() {
  const button = $("play-button");
  button.innerHTML = app.playing ? "Ⅱ <span>Pause</span>" : "▶ <span>Play</span>";
  button.setAttribute("aria-label", app.playing ? "Pause historical replay" : "Play historical replay");
}

function setToast(message, kind = "info") {
  let toast = $("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("is-visible");
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function evidenceRank(changes, corroborators) {
  const magnitudes = changes.filter((value) => Number.isFinite(Number(value))).map((value) => Math.abs(Number(value)));
  return Math.min(99, Math.round(48 + Math.min(30, (magnitudes.length ? Math.max(...magnitudes) : 0) * 0.4) + Math.min(20, corroborators * 4)));
}

function buildAlertCandidates() {
  const result = [];
  const priorMedian = (buildingId, day, field) => {
    const start = new Date(`${day}T00:00:00`);
    start.setDate(start.getDate() - 28);
    const startKey = toNaiveIsoHour(start).slice(0, 10);
    const values = app.data.daily.filter((row) => row.building_id === buildingId && dateKey(row.date) < day && dateKey(row.date) >= startKey && row[field] !== null && row[field] !== undefined).map((row) => Number(row[field])).sort((a, b) => a - b);
    if (!values.length) return null;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };
  const change = (value, baseline) => Number.isFinite(Number(value)) && Number.isFinite(Number(baseline)) && baseline !== 0 ? 100 * (Number(value) / Number(baseline) - 1) : null;
  const add = (candidate) => result.push(candidate);

  const foodDate = "2026-09-19";
  const food = dayByBuilding("B07", foodDate);
  const foodOccBase = priorMedian("B07", foodDate, "occupancy_avg");
  const foodEnergyBase = priorMedian("B07", foodDate, "electricity_kwh");
  const foodWasteBase = priorMedian("B07", foodDate, "wet_organic_kg");
  const foodEvent = calendarByDate(foodDate)?.event ?? "Scheduled alumni meet";
  const foodNote = app.data.manualLogs.find((row) => row.building_id_normalized === "B07" && dateKey(row.logged_at) === "2026-09-18" && row.note_raw);
  if (food) add({
    id: "food-court-event-surge", score: evidenceRank([change(food.electricity_kwh, foodEnergyBase), change(food.wet_organic_kg, foodWasteBase)], 3), date: foodDate, buildingId: "B07", severity: "HIGH PRIORITY", status: "Historical event", resolved: false,
    title: "Food Court demand rose with a scheduled alumni meet",
    summary: `Occupancy reached ${fmtNumber(food.occupancy_avg, 0)} (+${fmtNumber(change(food.occupancy_avg, foodOccBase), 0)}% vs the prior 28-day median), electricity rose ${fmtPercent(change(food.electricity_kwh, foodEnergyBase), 0)}, and wet waste rose ${fmtPercent(change(food.wet_organic_kg, foodWasteBase), 0)}.`,
    cause: `The event is the leading explanation. The calendar lists “${foodEvent}”; the prior-day operations note says “${foodNote?.note_raw ?? "extra cooking was planned"}”.`,
    action: "Before the next large meal event, stage a separate wet-waste point and confirm the collection pickup. Compare occupancy, meter and waste records again after service.",
    evidence: "Strong signal match · heuristic",
    caveat: "Event timing, higher occupancy and extra cooking align. This association does not prove the event caused each increase.",
    stats: [
      ["Occupancy", `${fmtNumber(food.occupancy_avg, 0)} vs ${fmtNumber(foodOccBase, 0)} people/day`, change(food.occupancy_avg, foodOccBase)],
      ["Electricity", `${fmtNumber(food.electricity_kwh, 0)} vs ${fmtNumber(foodEnergyBase, 0)} kWh`, change(food.electricity_kwh, foodEnergyBase)],
      ["Wet waste", `${fmtNumber(food.wet_organic_kg, 0)} vs ${fmtNumber(foodWasteBase, 0)} kg`, change(food.wet_organic_kg, foodWasteBase)],
    ],
    note: foodNote?.note_raw,
  });

  const leakDate = "2026-08-07";
  const leak = dayByBuilding("B06", leakDate);
  const leakBase = priorMedian("B06", leakDate, "water_litres");
  const leakNotes = app.data.manualLogs.filter((row) => row.building_id_normalized === "B06" && row.note_raw && ["2026-08-05", "2026-08-07", "2026-08-10"].includes(dateKey(row.logged_at)));
  const leakResolved = leakNotes.some((row) => /fixed|replaced/i.test(row.note_raw ?? ""));
  if (leak) add({
    id: "girls-hostel-water-leak", score: evidenceRank([change(leak.water_litres, leakBase)], leakNotes.length), date: leakDate, buildingId: "B06", severity: "WATER USE", status: leakResolved ? "Historical · repair note recorded" : "Historical candidate", resolved: leakResolved,
    title: "Girls Hostel water draw rose while staff reported a leak",
    summary: `Water reached ${fmtNumber(leak.water_litres, 0)} L, ${fmtPercent(change(leak.water_litres, leakBase), 0)} above the prior 28-day median of ${fmtNumber(leakBase, 0)} L.`,
    cause: `A leak is plausible. A staff note recorded a wet patch and frequent tank refill, then a suspected underground-line leak. ${leakResolved ? "A later note says the leak was fixed and the line replaced." : ""}`,
    action: leakResolved ? "The workbook records a repair. If a similar rise returns, compare the hourly flow and check the repaired line before dispatching another repair." : "Compare the flow meter with a reference reading and inspect the line near the reported wet patch.",
    evidence: "High evidence · manual notes plus a water rise",
    caveat: "The note and the increase agree in time. The dataset cannot establish the physical cause or repair quality.",
    stats: [["Water", `${fmtNumber(leak.water_litres, 0)} vs ${fmtNumber(leakBase, 0)} L/day`, change(leak.water_litres, leakBase)]],
    note: leakNotes.map((row) => `${formatDate(row.logged_at)}: ${row.note_raw}`).join(" "),
  });

  const holidayDate = "2026-10-02";
  const holiday = dayByBuilding("B03", holidayDate);
  const holidayOccBase = priorMedian("B03", holidayDate, "occupancy_avg");
  const holidayEnergyBase = priorMedian("B03", holidayDate, "electricity_kwh");
  const holidayNote = app.data.manualLogs.find((row) => row.building_id_normalized === "B03" && dateKey(row.logged_at) === holidayDate && /AC|lights/i.test(row.note_raw ?? ""));
  if (holiday) add({
    id: "library-holiday-idle-load", score: evidenceRank([change(holiday.electricity_kwh, holidayEnergyBase)], 2), date: holidayDate, buildingId: "B03", severity: "AFTER-HOURS CHECK", status: "Historical candidate", resolved: false,
    title: "Library occupancy fell on a holiday while electricity stayed near baseline",
    summary: `${fmtNumber(holiday.occupancy_avg, 0)} estimated occupants versus a prior median of ${fmtNumber(holidayOccBase, 0)}, while electricity was ${fmtNumber(holiday.electricity_kwh, 0)} kWh versus ${fmtNumber(holidayEnergyBase, 0)} kWh.`,
    cause: `The note reports “${holidayNote?.note_raw ?? "AC and lights left on"}” during the holiday. This supports an idle-load explanation, but the daily meter value is not materially above its recent median.`,
    action: "Review holiday HVAC and lighting schedules, then compare an after-hours interval before changing control settings.",
    evidence: "Moderate · low occupancy, stable load and a matching operator note",
    caveat: "A high per-occupant ratio can arise when the denominator is very small. The total electricity figure stayed near its baseline.",
    stats: [["Occupancy", `${fmtNumber(holiday.occupancy_avg, 0)} vs ${fmtNumber(holidayOccBase, 0)} people/day`, change(holiday.occupancy_avg, holidayOccBase)], ["Electricity", `${fmtNumber(holiday.electricity_kwh, 0)} vs ${fmtNumber(holidayEnergyBase, 0)} kWh`, change(holiday.electricity_kwh, holidayEnergyBase)]],
    note: holidayNote?.note_raw,
  });

  const meterDate = "2026-10-12";
  const meterNote = app.data.manualLogs.find((row) => row.building_id_normalized === "B02" && dateKey(row.logged_at) === meterDate && /flicker|meter/i.test(row.note_raw ?? ""));
  if (meterNote) add({
    id: "academic-block-b-meter-flicker", score: evidenceRank([], 1), date: meterDate, buildingId: "B02", severity: "DATA QUALITY", status: "Verify before action", resolved: false,
    title: "Academic Block B meter display may be unreliable",
    summary: `A coordinator recorded: “${meterNote.note_raw}” This is a measurement-quality concern, not proof of excess use.`,
    cause: "A display or meter fault is plausible from the direct note. No independent reference reading is available in the benchmark.",
    action: "Compare the meter with a known reference and inspect the connection before using this period to set an energy target.",
    evidence: "Low-to-moderate · one operator note, no independent meter check",
    caveat: "Do not infer an energy-saving action from a reading that may be incorrect.",
    stats: [],
    note: meterNote.note_raw,
  });
  return result.sort((a, b) => b.score - a.score);
}

function renderLineChart(container, points, options = {}) {
  if (!container) return;
  const usable = points.filter((point) => point.value !== null && point.value !== undefined && Number.isFinite(Number(point.value)));
  if (!usable.length) {
    container.innerHTML = `<div class="empty-card">${escapeHtml(options.emptyText ?? "No arrived measurements in this replay window.")}</div>`;
    return;
  }
  const width = 760;
  const height = options.height ?? 250;
  const left = 55;
  const right = 15;
  const top = 16;
  const bottom = 38;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const values = usable.map((point) => Number(point.value));
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(0, ...values);
  const span = maxValue - minValue || 1;
  const x = (index) => left + (usable.length <= 1 ? chartWidth / 2 : chartWidth * index / (usable.length - 1));
  const y = (value) => top + chartHeight - ((Number(value) - minValue) / span) * chartHeight;
  const path = usable.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const area = `${path} L${x(usable.length - 1)},${top + chartHeight} L${x(0)},${top + chartHeight} Z`;
  const ticks = [0, .25, .5, .75, 1];
  const grid = ticks.map((fraction) => {
    const yy = top + chartHeight - chartHeight * fraction;
    const value = minValue + span * fraction;
    return `<line class="chart-grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text class="chart-axis-label" x="${left - 9}" y="${yy + 3}" text-anchor="end">${escapeHtml(fmtCompact(value))}</text>`;
  }).join("");
  const dots = usable.map((point, index) => {
    if (usable.length > 34 && index % Math.ceil(usable.length / 22) !== 0 && index !== usable.length - 1) return "";
    const title = `${point.label ?? formatDateTime(point.time, { month: "short", day: "numeric", hour: "2-digit" })}: ${fmtNumber(point.value)} ${options.unit ?? ""}`;
    return `<circle class="chart-point" cx="${x(index)}" cy="${y(point.value)}" r="3"><title>${escapeHtml(title)}</title></circle>`;
  }).join("");
  const labelAt = [0, Math.floor((usable.length - 1) / 3), Math.floor(2 * (usable.length - 1) / 3), usable.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  const labels = labelAt.map((index) => `<text class="chart-axis-label" x="${x(index)}" y="${height - 9}" text-anchor="${index === 0 ? "start" : index === usable.length - 1 ? "end" : "middle"}">${escapeHtml(usable[index].label ?? formatDateTime(usable[index].time, { month: "short", day: "numeric", hour: "2-digit" }))}</text>`).join("");
  const aria = options.ariaLabel ?? "Historical resource readings";
  const accent = options.accent ?? "#4f7b68";
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(aria)}" style="--chart-accent:${accent}"><title>${escapeHtml(aria)}</title><desc>${usable.length} available values; missing values are omitted, not treated as zero.</desc><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".26"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>${grid}<path class="chart-area" d="${area}"/><path class="chart-path" d="${path}"/>${dots}${labels}</svg>`;
}

function setMetric(id, value, note, digits = 0) {
  $(id).textContent = value === null || value === undefined ? "—" : fmtNumber(value, digits);
  if (note) $(note[0]).textContent = note[1];
}

function renderMetricTrends(day) {
  const dates = day ? [...new Set(app.data.daily.map((row) => dateKey(row.date)).filter((date) => date && date <= day && date < cursorDate()))].sort().slice(-7) : [];
  const definitions = [
    { id: "metric-spark-energy", label: "Electricity", unit: "kWh", measure: (rows) => valueSum(rows, (row) => row.electricity_kwh).value },
    { id: "metric-spark-water", label: "Water", unit: "L", measure: (rows) => valueSum(rows, (row) => row.water_litres).value },
    { id: "metric-spark-waste", label: "Disposed mass", unit: "kg", measure: (rows) => valueSum(rows, dailyWaste).value },
    { id: "metric-spark-diversion", label: "Circular diversion", unit: "%", measure: (rows) => {
      const disposed = valueSum(rows, dailyWaste).value;
      const diverted = valueSum(rows, (row) => row.composted_kg == null || row.recycled_kg == null ? null : Number(row.composted_kg) + Number(row.recycled_kg)).value;
      return disposed !== null && disposed > 0 && diverted !== null ? 100 * diverted / disposed : null;
    } },
  ];
  for (const definition of definitions) {
    const target = $(definition.id);
    const points = dates.map((date) => ({ date, value: definition.measure(app.data.daily.filter((row) => dateKey(row.date) === date)) }));
    const latestIndex = points.findLastIndex((point) => point.value !== null && Number.isFinite(Number(point.value)));
    const available = points.filter((point) => point.value !== null && Number.isFinite(Number(point.value)));
    if (available.length < 2) {
      target.innerHTML = `<span class="metric-trend-label">7-day trend</span><span class="metric-trend-unavailable">Not enough complete days</span>`;
      continue;
    }
    const max = Math.max(...available.map((point) => Number(point.value)), 1);
    const width = 144, base = 25, slot = 20, barWidth = 11;
    const bars = points.map((point, index) => {
      const x = 3 + index * slot;
      if (point.value === null || !Number.isFinite(Number(point.value))) return `<rect class="spark-missing" x="${x}" y="23" width="${barWidth}" height="2" rx="1"><title>${formatDate(`${point.date}T12:00:00`)}: unavailable</title></rect>`;
      const height = 3 + 19 * Number(point.value) / max;
      const y = base - height;
      const valueLabel = definition.unit === "%" ? fmtPercent(point.value, 1) : `${fmtNumber(point.value, 0)} ${definition.unit}`;
      return `<rect class="spark-bar${index === latestIndex ? " is-latest" : ""}" x="${x}" y="${y.toFixed(1)}" width="${barWidth}" height="${height.toFixed(1)}" rx="2"><title>${formatDate(`${point.date}T12:00:00`)}: ${valueLabel}</title></rect>`;
    }).join("");
    const accessible = points.map((point) => `${formatDate(`${point.date}T12:00:00`)} ${point.value === null ? "unavailable" : definition.unit === "%" ? fmtPercent(point.value, 1) : `${fmtNumber(point.value, 0)} ${definition.unit}`}`).join("; ");
    target.innerHTML = `<span class="metric-trend-label">7-day trend</span><div class="metric-spark"><svg viewBox="0 0 ${width} 28" role="img" aria-label="${escapeHtml(`${definition.label}, past seven days: ${accessible}. Missing readings are unavailable, not zero.`)}"><line class="spark-baseline" x1="1" y1="25.5" x2="143" y2="25.5"/>${bars}</svg></div>`;
  }
}

function renderOverview() {
  const day = latestCompletedDay();
  $("overview-day-label").textContent = day ? `${formatDate(`${day}T12:00:00`)} · latest complete day` : "No completed daily summary yet";
  ["metric-day-energy", "metric-day-water", "metric-day-waste", "metric-day-diversion"].forEach((id) => { $(id).textContent = day ? formatDate(`${day}T12:00:00`, { day: "numeric", month: "short" }) : "Unavailable"; });
  const rows = day ? app.data.daily.filter((row) => dateKey(row.date) === day) : [];
  const energy = valueSum(rows, (row) => row.electricity_kwh);
  const water = valueSum(rows, (row) => row.water_litres);
  const waste = valueSum(rows, dailyWaste);
  const diverted = valueSum(rows, (row) => row.composted_kg !== null && row.recycled_kg !== null ? Number(row.composted_kg) + Number(row.recycled_kg) : null);
  const denominator = valueSum(rows, dailyWaste);
  const diversion = diverted.value !== null && denominator.value !== null && denominator.value > 0 ? diverted.value / denominator.value * 100 : null;
  $("metric-electricity").textContent = energy.value === null ? "—" : fmtCompact(energy.value);
  $("metric-water").textContent = water.value === null ? "—" : fmtCompact(water.value);
  $("metric-waste").textContent = waste.value === null ? "—" : fmtCompact(waste.value);
  $("metric-diversion").textContent = diversion === null ? "—" : fmtPercent(diversion, 1);
  $("metric-electricity-note").textContent = `${energy.available}/8 buildings with a value${energy.value === null ? " · campus total unavailable" : ""}`;
  $("metric-water-note").textContent = `${water.available}/8 buildings with a value${water.value === null ? " · campus total unavailable" : ""}`;
  $("metric-waste-note").textContent = "Disposed mass = compost + recycling + landfill";
  $("metric-diversion-note").textContent = diversion === null ? "Missing mass data is not counted as zero" : "Compost + recycling ÷ disposed mass";
  renderMetricTrends(day);

  const chartBuilding = buildingById(app.selectedBuilding) ?? app.data.buildings[0];
  const chartRows = visibleHourRows(chartBuilding.building_id).filter((row) => Date.parse(row.timestamp) <= Date.parse(currentCursor())).sort(sourceTimestampSort).slice(-24);
  const resource = $("overview-resource").value;
  const resourceLabel = resource === "electricity_kwh" ? "Electricity · kWh" : resource === "water_litres" ? "Water · L" : "Footfall · passages";
  const unit = resource === "electricity_kwh" ? "kWh" : resource === "water_litres" ? "L" : "passages";
  const points = chartRows.map((row) => ({ time: row.timestamp, value: row[resource], label: formatDateTime(row.timestamp, { hour: "2-digit", minute: "2-digit" }) }));
  $("overview-chart-caption").textContent = `${chartBuilding.building_id} · ${chartBuilding.building_name} · available capture readings`;
  $("overview-chart-source").textContent = `${resourceLabel} · benchmark stream`;
  const accent = resource === "electricity_kwh" ? "#92730f" : resource === "water_litres" ? "#4e758a" : "#4f7b68";
  renderLineChart($("overview-chart"), points, { unit, accent, ariaLabel: `${resourceLabel} for ${chartBuilding.building_name} in the selected historical replay window` });

  const topAlerts = app.alerts.filter((alert) => alert.date <= cursorDate()).slice(0, 3);
  $("attention-list").innerHTML = topAlerts.length ? topAlerts.map((alert) => `<button class="attention-item" type="button" data-alert-view="${escapeHtml(alert.id)}"><i class="status-dot ${alert.resolved ? "is-green" : "is-amber"}" aria-hidden="true"></i><span><span class="attention-title">${escapeHtml(alert.title)}</span><span class="attention-sub">${escapeHtml(formatDate(`${alert.date}T12:00:00`))} · ${escapeHtml(labelBuilding(alert.buildingId))} · ${escapeHtml(alert.evidence)}</span></span></button>`).join("") : `<div class="empty-card">No ranked evidence before this replay time.</div>`;

  const candidates = app.alerts.filter((alert) => alert.date <= cursorDate());
  const top = candidates[0];
  $("priority-title").textContent = top ? top.title : "No earlier evidence in the selected window";
  $("priority-description").textContent = top ? `${formatDate(`${top.date}T12:00:00`)} · ${top.summary} The cause is a hypothesis, not a proven relationship.` : "Move the replay forward to see contextual evidence from schedules, field notes and telemetry.";

  $("overview-buildings").innerHTML = app.data.buildings.map((building) => {
    const status = freshnessFor(building.building_id);
    const daily = day ? dayByBuilding(building.building_id, day) : null;
    const energyText = daily?.electricity_kwh == null ? "—" : fmtNumber(daily.electricity_kwh, 0);
    const waterText = daily?.water_litres == null ? "—" : fmtCompact(daily.water_litres);
    const wasteValue = dailyWaste(daily);
    const wasteText = wasteValue === null ? "—" : fmtNumber(wasteValue, 0);
    const diversionText = diversionPercent(daily) === null ? "—" : fmtPercent(diversionPercent(daily), 0);
    return `<button class="building-card" type="button" data-building="${escapeHtml(building.building_id)}" aria-label="Open ${escapeHtml(building.building_id)} ${escapeHtml(building.building_name)} detail"><span class="building-card-top"><span class="building-id">${escapeHtml(building.building_id)}</span><span class="status-pill"><i class="status-dot ${statusDotClass(status.status)}"></i>${escapeHtml(status.label)}</span></span><span class="building-name">${escapeHtml(building.building_name)} <small>(benchmark)</small></span><span class="building-card-metrics"><span><strong>${energyText}</strong> kWh</span><span><strong>${waterText}</strong> L</span><span><strong>${wasteText}</strong> kg waste</span><span><strong>${diversionText}</strong> diverted</span></span></button>`;
  }).join("");
  const offlineCount = app.demo.offline.length;
  const latest = app.data.benchmark.latest_hourly_arrival;
  $("freshness-summary").textContent = `Data is historical and synthetic · latest source arrival ${formatDateTime(latest)} · ${offlineCount ? `${offlineCount} building${offlineCount === 1 ? " is" : "s are"} in the offline replay` : "all buildings visible in replay"}.`;
}

function renderCampus() {
  const resources = {
    electricity_kwh: { label: "Grid electricity", short: "Energy", unit: "kWh", value: (row) => row?.electricity_kwh, format: (value) => `${fmtCompact(value)} kWh` },
    water_litres: { label: "Water draw", short: "Water", unit: "L", value: (row) => row?.water_litres, format: (value) => `${fmtCompact(value)} L` },
    waste_kg: { label: "Disposed waste", short: "Waste", unit: "kg", value: dailyWaste, format: (value) => `${fmtNumber(value, 0)} kg` },
    diversion_pct: { label: "Circular diversion", short: "Diverted", unit: "%", value: diversionPercent, format: (value) => fmtPercent(value, 1) },
  };
  const resource = resources[app.campusResource] ?? resources.electricity_kwh;
  const day = latestCompletedDay();
  const rows = app.data.buildings.map((building) => ({ building, daily: day ? dayByBuilding(building.building_id, day) : null, freshness: freshnessFor(building.building_id) }));
  const values = rows.map(({ daily }) => resource.value(daily)).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
  const maximum = Math.max(1, ...values);
  const coverage = values.length;
  const total = app.campusResource === "diversion_pct"
    ? (() => {
      const available = rows.map(({ daily }) => daily).filter((row) => row && [row.composted_kg, row.recycled_kg, row.landfill_kg].every((value) => value !== null && value !== undefined));
      if (!available.length) return null;
      const diverted = available.reduce((sum, row) => sum + Number(row.composted_kg) + Number(row.recycled_kg), 0);
      const disposed = available.reduce((sum, row) => sum + Number(row.composted_kg) + Number(row.recycled_kg) + Number(row.landfill_kg), 0);
      return disposed > 0 ? diverted / disposed * 100 : null;
    })()
    : values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  $("map-reading-date").textContent = day ? `${formatDate(`${day}T12:00:00`, { day: "numeric", month: "short", year: "numeric" })} · complete day` : "No complete daily record";
  const aggregate = $("map-reading-total");
  if (aggregate) {
    aggregate.textContent = total === null ? "Unavailable" : resource.format(total);
    aggregate.title = `${resource.label}; ${coverage} of ${rows.length} building rows available${coverage < rows.length ? ". Partial values are not treated as complete campus totals." : "."}`;
    $("map-total-coverage").textContent = `${coverage}/${rows.length} records · ${resource.short.toLowerCase()} total`;
  }
  document.querySelectorAll("[data-campus-resource]").forEach((button) => {
    const active = button.dataset.campusResource === app.campusResource;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("schematic-buildings").innerHTML = rows.map(({ building, daily, freshness }) => {
    const value = resource.value(daily);
    const available = value !== null && value !== undefined && Number.isFinite(Number(value));
    const ratio = available ? Math.max(5, Number(value) / maximum * 100) : 0;
    const statusName = freshness.status === "recent" ? "Recent" : freshness.status === "delayed" || freshness.status === "stale" ? "Delayed or stale" : freshness.status === "offline" ? "Offline" : "Missing";
    const metric = available ? resource.format(Number(value)) : "Unavailable";
    const selected = building.building_id === app.selectedBuilding;
    const label = `${building.building_id}, ${building.building_name}, ${metric} ${resource.label}, ${statusName} in benchmark replay`;
    return `<button type="button" class="schematic-building${selected ? " is-selected" : ""}" data-map-building="${escapeHtml(building.building_id)}" aria-label="Select ${escapeHtml(label)}" aria-pressed="${selected}"><span class="map-node-top"><span class="building-id">${escapeHtml(building.building_id)}</span><span class="map-node-status"><i class="status-dot ${statusDotClass(freshness.status)}" aria-hidden="true"></i>${escapeHtml(freshness.status === "recent" ? "Recent" : freshness.status === "offline" ? "Offline" : freshness.status === "missing" ? "No data" : "Stale")}</span></span><span class="map-building-glyph" aria-hidden="true"><i></i><i></i><i></i><i></i></span><strong>${escapeHtml(building.building_name)}</strong><span class="map-node-reading">${escapeHtml(metric)}</span><span class="map-node-meter" aria-hidden="true"><i class="${available ? "" : "is-empty"}" style="width:${ratio}%"></i></span><small>${escapeHtml(building.building_type)} · ${integerFormat.format(Number(building.floors) || 0)} floors</small></button>`;
  }).join("");

  const selected = buildingById(app.selectedBuilding) ?? app.data.buildings[0];
  const selectedRow = day ? dayByBuilding(selected.building_id, day) : null;
  const selectedValue = resource.value(selectedRow);
  const selectedFreshness = freshnessFor(selected.building_id);
  const selectedAlerts = app.alerts.filter((alert) => alert.buildingId === selected.building_id && alert.date <= cursorDate()).sort((a, b) => b.date.localeCompare(a.date));
  const selectedAlert = selectedAlerts[0];
  $("map-selected-building").innerHTML = `<div class="map-detail-kicker"><span>SELECTED BENCHMARK RECORD</span><span class="map-detail-id">${escapeHtml(selected.building_id)}</span></div><div class="map-detail-icon" aria-hidden="true"><span class="map-building-glyph"><i></i><i></i><i></i><i></i></span></div><h3>${escapeHtml(selected.building_name)}</h3><p class="map-detail-type">${escapeHtml(selected.building_type)} · ${integerFormat.format(Number(selected.floors) || 0)} floors</p><div class="map-detail-measure"><span>${escapeHtml(resource.label)} · ${escapeHtml(resource.unit)}</span><strong>${selectedValue == null ? "Unavailable" : escapeHtml(resource.format(Number(selectedValue)))}</strong><small>${day ? `Latest complete day · ${escapeHtml(formatDate(`${day}T12:00:00`, { day: "numeric", month: "short" }))}` : "No complete daily record"}</small></div><div class="map-detail-freshness"><i class="status-dot ${statusDotClass(selectedFreshness.status)}"></i><span>${escapeHtml(selectedFreshness.label)}<small>Arrival status at the replay cursor</small></span></div>${selectedAlert ? `<div class="map-evidence"><span class="eyebrow">RANKED EVIDENCE · ${escapeHtml(formatDate(`${selectedAlert.date}T12:00:00`, { day: "numeric", month: "short" }))}</span><strong>${escapeHtml(selectedAlert.title)}</strong><small>${escapeHtml(selectedAlert.evidence)} · hypothesis, not proven cause</small><button type="button" class="text-button" data-alert-view="${escapeHtml(selectedAlert.id)}">Review evidence <span aria-hidden="true">→</span></button></div>` : `<div class="map-no-evidence"><i aria-hidden="true">✓</i><span>No ranked alert for this building by the selected replay time.</span></div>`}<button type="button" class="button button-primary map-open-detail" data-building="${escapeHtml(selected.building_id)}">Open building detail <span aria-hidden="true">→</span></button><p class="map-detail-note">Synthetic benchmark metadata · not a verified campus building match.</p>`;
}

function renderBuildingPicker() {
  const picker = $("building-picker-options");
  if (picker.dataset.ready !== "true") {
    picker.innerHTML = app.data.buildings.map((building) => `<button type="button" class="building-option" data-building-select="${escapeHtml(building.building_id)}" aria-pressed="false"><span class="building-option-id">${escapeHtml(building.building_id)}</span><span class="building-option-copy"><strong>${escapeHtml(building.building_name)}</strong><small>Benchmark record</small></span><span class="building-option-check" aria-hidden="true">✓</span></button>`).join("");
    picker.dataset.ready = "true";
    $("building-picker-count").textContent = String(app.data.buildings.length).padStart(2, "0");
  }
  picker.querySelectorAll("[data-building-select]").forEach((button) => {
    const selected = button.dataset.buildingSelect === app.selectedBuilding;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function forecastFor(buildingId, horizon) {
  const model = app.forecast?.models?.[String(horizon)];
  if (!model) return null;
  const origin = floorHour(currentCursor());
  const targetDate = shiftHour(origin, horizon);
  const targetTs = toNaiveIsoHour(targetDate);
  const currentMs = Date.parse(currentCursor());
  const history = visibleHourRows(buildingId);
  const byCapture = new Map(history.map((row) => [captureHourKey(row.timestamp), row]));
  const targetMinus = (hours) => captureHourKey(shiftHour(targetDate, -hours));
  const originMinus = (hours) => captureHourKey(shiftHour(origin, -hours));
  const featureValues = {};
  for (const lag of [24, 48, 168]) {
    const row = byCapture.get(targetMinus(lag));
    featureValues[`lag${lag}`] = row && row.electricity_kwh != null && Date.parse(row.received_at) <= currentMs ? Number(row.electricity_kwh) : null;
  }
  const recentEnergy = [];
  const recentFootfall = [];
  let latest = null;
  for (let lag = 1; lag <= 24; lag += 1) {
    const row = byCapture.get(originMinus(lag));
    if (!row || Date.parse(row.received_at) > currentMs) continue;
    latest = latest ?? row;
    if (row.electricity_kwh != null) recentEnergy.push(Number(row.electricity_kwh));
    if (row.footfall != null) recentFootfall.push(Number(row.footfall));
    if (recentEnergy.length >= 6 && recentFootfall.length >= 6) break;
  }
  if (!latest) return { unavailable: true, horizon, reason: "No arrived readings are available within the previous 24 hours." };
  featureValues.latest = latest.electricity_kwh == null ? null : Number(latest.electricity_kwh);
  featureValues.rolling6 = recentEnergy.length ? recentEnergy.slice(0, 6).reduce((sum, value) => sum + value, 0) / Math.min(6, recentEnergy.length) : null;
  const dayLag = byCapture.get(targetMinus(24));
  featureValues.footfall24 = dayLag?.footfall == null ? null : Number(dayLag.footfall);
  featureValues.latest_footfall = recentFootfall[0] ?? null;
  featureValues.hour_sin = Math.sin(2 * Math.PI * targetDate.getHours() / 24);
  featureValues.hour_cos = Math.cos(2 * Math.PI * targetDate.getHours() / 24);
  featureValues.dow_sin = Math.sin(2 * Math.PI * targetDate.getDay() / 7);
  featureValues.dow_cos = Math.cos(2 * Math.PI * targetDate.getDay() / 7);
  const calendar = calendarByDate(dateKey(targetTs));
  if (calendar) {
    const event = String(calendar.event ?? "");
    const dayType = String(calendar.day_type ?? "");
    featureValues.event = Number(Boolean(event));
    featureValues.is_working = Number(["working", "exam"].includes(dayType));
    featureValues.is_weekend = Number(dayType === "weekend");
    featureValues.is_exam = Number(dayType.toLowerCase().includes("exam") || event.toLowerCase().includes("exam"));
  } else {
    featureValues.event = null;
    featureValues.is_working = null;
    featureValues.is_weekend = null;
    featureValues.is_exam = null;
  }
  for (const building of app.data.buildings) featureValues[`building_${building.building_id}`] = Number(building.building_id === buildingId);
  const vector = model.feature_names.map((name, index) => Number.isFinite(featureValues[name]) ? featureValues[name] : model.imputation_medians[index]);
  let estimate = model.target_mean;
  for (let i = 0; i < vector.length; i += 1) estimate += ((vector[i] - model.means[i]) / model.scales[i]) * model.coefficients[i];
  estimate = Math.max(0, estimate);
  return {
    estimate,
    low: Math.max(0, estimate - model.validation_abs_error_p90_kwh),
    high: estimate + model.validation_abs_error_p90_kwh,
    baseline: featureValues.lag24,
    targetTs,
    scheduleAvailable: Boolean(calendar),
    interval: model.validation_abs_error_p90_kwh,
    horizon,
  };
}

function drawForecastChart(container, forecasts) {
  const available = forecasts.filter((item) => !item.unavailable);
  if (!available.length) {
    container.innerHTML = `<div class="empty-card">No forecast until enough arrived history is available.</div>`;
    return;
  }
  const width = 580, height = 150, left = 34, right = 18, top = 16, bottom = 30;
  const values = available.flatMap((item) => [item.low, item.estimate, item.high, item.baseline]).filter(Number.isFinite);
  const max = Math.max(...values, 1), min = Math.min(0, ...values), span = max - min || 1;
  const y = (value) => top + (height - top - bottom) * (1 - (value - min) / span);
  const xs = available.map((_, index) => left + (width - left - right) * (index / Math.max(1, available.length - 1)));
  const x0 = left + 24, x1 = width - right - 20;
  const points = available.map((item, index) => ({ ...item, x: available.length === 1 ? (x0 + x1) / 2 : xs[index] }));
  const baseline = points.map((item) => `${item.x},${y(item.baseline)}`).join(" ");
  const band = points.map((item) => `${item.x},${y(item.high)}`).join(" ") + " " + points.slice().reverse().map((item) => `${item.x},${y(item.low)}`).join(" ");
  const estimatePath = points.map((item, index) => `${index ? "L" : "M"}${item.x},${y(item.estimate)}`).join(" ");
  const grid = [0, .5, 1].map((fraction) => {
    const yy = top + (height - top - bottom) * fraction;
    const value = max * (1 - fraction);
    return `<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" stroke="#e4e8eb"/><text x="${left-5}" y="${yy+3}" text-anchor="end">${escapeHtml(fmtCompact(value))}</text>`;
  }).join("");
  const marks = points.map((item) => `<circle class="forecast-dot" cx="${item.x}" cy="${y(item.estimate)}" r="5"><title>${item.horizon} hour forecast ${fmtNumber(item.estimate)} kWh. Historical 90th percentile absolute error is ±${fmtNumber(item.interval)} kWh.</title></circle><text x="${item.x}" y="${height-8}" text-anchor="middle">+${item.horizon} h</text>`).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Six and twelve hour electricity forecasts with empirical error ranges">${grid}<polygon class="band" points="${band}"/><polyline points="${baseline}" fill="none" stroke="#9aa3ae" stroke-width="1.5" stroke-dasharray="3 4"/><path d="${estimatePath}" fill="none" stroke="#92730f" stroke-width="2.5"/>${marks}</svg>`;
}

function renderBuildingDetail() {
  const building = buildingById(app.selectedBuilding) ?? app.data.buildings[0];
  app.selectedBuilding = building.building_id;
  renderBuildingPicker();
  const freshness = freshnessFor(building.building_id);
  const offline = app.demo.offline.some((row) => row.building_id === building.building_id);
  const queued = app.demo.queued.find((row) => row.building_id === building.building_id)?.count ?? 0;
  $("building-detail-heading").innerHTML = `<div class="detail-title-block"><span class="building-monogram">${escapeHtml(building.building_id)}</span><div><h2>${escapeHtml(building.building_name)} <span class="building-id">· SYNTHETIC BENCHMARK LABEL</span></h2><p>${escapeHtml(building.building_type)} · ${fmtNumber(building.area_sqm, 0)} m² hypothetical metadata · ${escapeHtml(freshness.label)}</p></div></div><div class="detail-actions"><span class="data-chip">${escapeHtml(freshness.record ? `Last capture ${formatDateTime(freshness.record.timestamp)}` : "No capture available")}</span><button id="offline-toggle" class="button ${offline ? "button-dark" : "button-quiet"}" type="button">${offline ? `Reconnect · ${integerFormat.format(queued)} queued` : "Simulate offline"}</button></div>`;
  const completed = latestCompletedDay();
  const daily = completed ? dayByBuilding(building.building_id, completed) : null;
  const solar = building.has_solar ? (daily?.solar_generation_kwh ?? null) : null;
  const stats = [
    ["Electricity · kWh/day", daily?.electricity_kwh, completed ? `Completed summary · ${formatDate(`${completed}T12:00:00`)}` : "No completed day"],
    ["Water · L/day", daily?.water_litres, "Daily summary · synthetic benchmark"],
    ["Occupancy · people/day", daily?.occupancy_avg, "Estimated daily average"],
    ["Solar · kWh/day", solar, building.has_solar ? "Daily summary · synthetic benchmark" : "No solar array in benchmark metadata"],
  ];
  $("detail-summary").innerHTML = stats.map(([label, value, note]) => `<div class="detail-stat"><span>${escapeHtml(label)}</span><strong>${value == null ? "Unavailable" : fmtCompact(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");

  const resource = $("building-resource").value;
  const rows = visibleHourRows(building.building_id).filter((row) => Date.parse(row.timestamp) <= Date.parse(currentCursor())).sort(sourceTimestampSort).slice(-24);
  const resourceLabel = resource === "electricity_kwh" ? "electricity" : resource === "water_litres" ? "water" : resource === "solar_generation_kwh" ? "solar output" : "footfall";
  const unit = resource === "electricity_kwh" || resource === "solar_generation_kwh" ? "kWh" : resource === "water_litres" ? "L" : "passages";
  $("building-hourly-caption").textContent = `${rows.length} arrived readings in the last 24 capture hours · capture and arrival times are separate.`;
  const accent = resource === "electricity_kwh" ? "#92730f" : resource === "water_litres" ? "#4e758a" : resource === "solar_generation_kwh" ? "#4f7b68" : "#1c273b";
  renderLineChart($("building-hourly-chart"), rows.map((row) => ({ time: row.timestamp, value: row[resource], label: formatDateTime(row.timestamp, { hour: "2-digit", minute: "2-digit" }) })), { height: 310, unit, accent, ariaLabel: `Recent hourly ${resourceLabel} values for ${building.building_name}` });
  const missingCount = rows.filter((row) => row[resource] == null).length;
  const delayedCount = rows.filter((row) => row.quality_flags?.includes("delayed_arrival") || row.quality_flags?.includes("severely_delayed_arrival")).length;
  const noisyCount = rows.filter((row) => row.quality_flags?.some((flag) => flag.startsWith("possible_noisy_spike_"))).length;
  $("building-quality-note").textContent = `${missingCount} of ${rows.length} chart slots are missing for this measure. ${delayedCount} arrived more than two hours after capture; ${noisyCount} row${noisyCount === 1 ? "" : "s"} crossed a robust per-building, same-hour channel outlier check. Values are retained, flagged and never silently smoothed.`;

  const forecasts = [forecastFor(building.building_id, 6), forecastFor(building.building_id, 12)];
  $("forecast-points").innerHTML = forecasts.map((result) => result?.unavailable ? `<div class="forecast-point"><span class="forecast-horizon">+${result.horizon} h</span><strong>Unavailable</strong><small>${escapeHtml(result.reason)}</small></div>` : `<div class="forecast-point"><span class="forecast-horizon">+${result.horizon} h · ${escapeHtml(formatDateTime(result.targetTs))}</span><strong>${fmtNumber(result.estimate)} kWh</strong><small>Range ${fmtNumber(result.low)}–${fmtNumber(result.high)} kWh · ±${fmtNumber(result.interval)} p90 error</small><small>Seasonal baseline ${fmtNumber(result.baseline)} kWh</small></div>`).join("");
  drawForecastChart($("forecast-chart"), forecasts.filter(Boolean));
  const noContext = forecasts.some((result) => result && !result.unavailable && !result.scheduleAvailable);
  $("forecast-context-note").textContent = `${noContext ? "The benchmark calendar ends before this forecast target; schedule features use the model's training median. " : "Known benchmark calendar schedule is used; future observed weather and footfall are not used. "}The band is the 90th percentile absolute error from a later-period holdout, not a guaranteed interval.`;

  renderBuildingEvents(building.building_id);
  const latest = latestAvailable(building.building_id);
  $("building-source-detail").innerHTML = latest ? `<div class="source-record"><dl><dt>Capture time</dt><dd>${escapeHtml(formatDateTime(latest.timestamp))}</dd><dt>Arrival time</dt><dd>${escapeHtml(formatDateTime(latest.received_at))}</dd><dt>Arrival delay</dt><dd>${fmtNumber(latest.arrival_lag_hours)} h</dd><dt>Source row</dt><dd>hourly_streams.xlsx · hourly_streams · ${latest.source_row}</dd><dt>Source records</dt><dd>${latest.source_count} row${latest.source_count === 1 ? "" : "s"} for this capture key</dd><dt>Quality flags</dt><dd>${latest.quality_flags?.length ? escapeHtml(latest.quality_flags.join(", ")) : "None recorded"}</dd></dl><button type="button" class="button button-quiet button-sm" data-source-row="${latest.source_row}" data-source-file="hourly_streams.xlsx" data-source-sheet="hourly_streams">Open source row</button></div>` : `<div class="empty-card">No source reading has arrived for this building by the selected replay time.</div>`;
}

function renderBuildingEvents(buildingId) {
  const cursor = currentCursor();
  const cutoff = toNaiveIsoHour(shiftHour(asDate(cursor), -24 * 7)).slice(0, 10);
  const cursorMs = Date.parse(cursor);
  const logs = app.data.manualLogs.filter((row) => row.building_id_normalized === buildingId && Date.parse(row.logged_at) <= cursorMs && dateKey(row.logged_at) >= cutoff).sort((a, b) => Date.parse(b.logged_at) - Date.parse(a.logged_at)).slice(0, 5);
  const event = calendarByDate(cursorDate());
  const items = [];
  if (event?.event) items.push(`<div class="event-row"><time>${escapeHtml(formatDate(`${cursorDate()}T12:00:00`))} · BENCHMARK CALENDAR</time><strong>${escapeHtml(event.event)}</strong><p>${escapeHtml(event.day_type)} · ${fmtNumber(event.avg_temp_c)} °C mean temperature and ${fmtNumber(event.rainfall_mm)} mm rainfall in the benchmark calendar.</p></div>`);
  for (const log of logs) {
    const value = log.value_normalized == null ? "" : `${fmtNumber(log.value_normalized)} ${log.unit_normalized ?? ""} · `;
    items.push(`<div class="event-row"><time>${escapeHtml(formatDateTime(log.logged_at))} · ${escapeHtml(log.logger_role.replaceAll("_", " "))}</time><strong>${escapeHtml(value + (log.note_raw ?? `${log.stream_raw} manual entry`))}</strong><p>${log.quality_flags?.length ? `Quality flag: ${escapeHtml(log.quality_flags.join(", "))}. ` : ""}Original ${escapeHtml(String(log.value_raw ?? "missing"))} ${escapeHtml(log.unit_raw ?? "")} · ${escapeHtml(log.building_alias_raw)} → ${escapeHtml(log.building_id_normalized ?? "unmapped")}</p></div>`);
  }
  $("building-events").innerHTML = items.length ? items.join("") : `<div class="empty-card">No schedule event or manual log is available for this building in the recent replay window.</div>`;
}

function renderWaste() {
  const evaluation = app.waste.evaluation;
  const report = evaluation;
  const classes = report.classes ?? Object.keys(report.per_class);
  const macro = report.macro_f1;
  const latency = app.waste.benchmark?.p95Ms ?? null;
  const stats = [
    ["Chronological holdout accuracy", fmtPercent(report.accuracy * 100, 1), `${report.validation_rows} later-period labeled events`],
    ["Macro F1", fmtNumber(macro * 100, 1) + "%", "Average F1 across six classes"],
    ["Model footprint", `${fmtNumber(app.waste.model.node_count, 0)} nodes`, `${app.waste.model.tree_count} shallow CPU trees`],
    ["Shipped JavaScript inference", `${fmtNumber(latency, 3)} ms p95/event`, app.waste.benchmark ? `${app.waste.benchmark.runtime} · ${app.waste.benchmark.architecture} · ${app.waste.benchmark.measuredEvents} events` : "Run npm run benchmark:model for a host measurement"],
  ];
  $("waste-model-summary").innerHTML = stats.map(([label, value, note]) => `<div class="model-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
  $("waste-accuracy-badge").textContent = fmtPercent(report.accuracy * 100, 1);
  const tbody = $("waste-metrics-table").querySelector("tbody");
  tbody.innerHTML = classes.map((name) => {
    const row = report.per_class[name];
    return `<tr><td>${escapeHtml(name.replaceAll("_", " "))}</td><td>${integerFormat.format(row.support)}</td><td>${fmtPercent(row.precision * 100, 1)}</td><td>${fmtPercent(row.recall * 100, 1)}</td><td>${fmtPercent(row.f1 * 100, 1)}</td></tr>`;
  }).join("") + `<tr><td>Macro average</td><td>—</td><td>—</td><td>—</td><td>${fmtPercent(report.macro_f1 * 100, 1)}</td></tr>`;

  const matrix = report.confusion_matrix;
  $("confusion-matrix").innerHTML = `<table class="matrix-table"><thead><tr><th scope="col">Actual ↓<br />Predicted →</th>${classes.map((name) => `<th scope="col">${escapeHtml(shortClass(name))}</th>`).join("")}</tr></thead><tbody>${matrix.map((row, i) => `<tr><th scope="row">${escapeHtml(shortClass(classes[i]))}</th>${row.map((value, j) => `<td class="${i === j ? "diagonal" : "off-diagonal"}" title="Actual ${escapeHtml(classes[i])}; predicted ${escapeHtml(classes[j])}">${integerFormat.format(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  const filter = $("waste-class-filter");
  if (filter.options.length <= 1) filter.innerHTML += classes.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name.replaceAll("_", " "))}</option>`).join("");
  filter.value = app.selectedWasteClass;
  const matching = app.waste.testPreview.events.filter((event) => app.selectedWasteClass === "all" || event.predicted_class === app.selectedWasteClass);
  const eventPicker = $("waste-test-event");
  const selected = eventPicker.value;
  eventPicker.innerHTML = matching.slice(0, 140).map((event) => `<option value="${escapeHtml(event.event_id)}">${escapeHtml(event.event_id)} · ${escapeHtml(event.predicted_class.replaceAll("_", " "))} · ${fmtPercent(event.top_score * 100, 0)}</option>`).join("");
  if (matching.some((event) => event.event_id === selected)) eventPicker.value = selected;
  renderWastePreview();
}

function shortClass(name) {
  return ({ food_organic: "Food", paper_cardboard: "Paper", plastic: "Plastic", glass: "Glass", metal: "Metal", ewaste: "E-waste" })[name] ?? name;
}

function renderWastePreview() {
  const event = app.waste.testPreview.events.find((row) => row.event_id === $("waste-test-event").value);
  if (!event) {
    $("waste-event-detail").innerHTML = `<div class="empty-card">No event matches this predicted class in the unlabelled stream.</div>`;
    return;
  }
  $("waste-event-detail").innerHTML = `<div class="event-class"><span><strong>${escapeHtml(event.predicted_class.replaceAll("_", " "))}</strong><br /><small>${escapeHtml(event.event_id)} · ${escapeHtml(formatDateTime(event.timestamp))}</small></span><span>${event.needs_review ? "Manual review" : "Top model score"}<br /><strong>${fmtPercent(event.top_score * 100, 0)}</strong></span></div><div class="waste-feature-grid">${Object.entries(event.features).map(([name, value]) => `<div class="waste-feature">${escapeHtml(name.replaceAll("_", " "))}<strong>${value == null ? "Missing" : fmtNumber(value, 2)}</strong></div>`).join("")}</div><p class="chart-note">Ground truth unavailable. The prediction cannot be scored against this test row.</p>`;
  const form = $("classify-form");
  for (const [name, value] of Object.entries(event.features)) form.elements[name].value = value == null ? "" : value;
}

function acknowledgedAlertIds() {
  try { return new Set(JSON.parse(localStorage.getItem("campulse-acknowledged-alerts") || "[]")); }
  catch { return new Set(); }
}

function renderAlerts() {
  const visible = app.alerts.filter((alert) => alert.date <= cursorDate());
  const acknowledged = acknowledgedAlertIds();
  $("alert-count-chip").textContent = `${visible.length} historical candidate${visible.length === 1 ? "" : "s"} before replay time`;
  $("nav-alert-count").textContent = String(visible.length);
  $("alerts-list").innerHTML = visible.length ? visible.map((alert) => {
    const done = alert.resolved || acknowledged.has(alert.id);
    const icon = alert.severity === "DATA QUALITY" ? "!" : alert.severity === "AFTER-HOURS CHECK" ? "◷" : "↗";
    const signalVisual = alert.stats.length ? `<div class="alert-signals" aria-label="Evidence changes compared with the prior 28-day median"><div class="alert-signals-heading">Signals vs prior 28-day median</div>${alert.stats.map(([label, detail, change]) => {
      const available = change !== null && change !== undefined && Number.isFinite(Number(change));
      const delta = Number(change);
      const width = available ? Math.max(3, Math.min(100, Math.abs(delta))) : 0;
      return `<div class="alert-signal"><div class="alert-signal-top"><span>${escapeHtml(label)}</span><strong class="${available && delta >= 0 ? "is-rise" : "is-fall"}">${available ? `${delta > 0 ? "+" : ""}${fmtNumber(delta, 0)}%` : "Unavailable"}</strong></div><div class="alert-signal-track" aria-hidden="true"><i class="${available ? delta >= 0 ? "is-rise" : "is-fall" : "is-missing"}" style="width:${width}%"></i></div><small>${escapeHtml(detail)}</small></div>`;
    }).join("")}</div>` : "";
    return `<article id="alert-${escapeHtml(alert.id)}" class="alert-card ${done ? "is-resolved" : ""} ${alert.severity === "DATA QUALITY" ? "is-low" : ""}">
      <div class="alert-icon" aria-hidden="true">${icon}</div>
      <div><div class="alert-title-row"><h2>${escapeHtml(alert.title)}</h2><span class="priority-tag">${escapeHtml(alert.severity)}</span><span class="evidence-tag">Rank ${alert.score}/100 · heuristic</span>${done ? `<span class="resolved-tag">${alert.resolved ? "Repair note recorded" : "Reviewed locally"}</span>` : ""}</div>
      <p class="alert-meta">${escapeHtml(formatDate(`${alert.date}T12:00:00`))} · ${escapeHtml(alert.buildingId)} · ${escapeHtml(labelBuilding(alert.buildingId))} · ${escapeHtml(alert.status)}</p>
      <p class="alert-detail">${escapeHtml(alert.summary)}</p>${signalVisual}<p class="alert-detail"><strong>Leading explanation:</strong> ${escapeHtml(alert.cause)}</p>
      <div class="alert-action"><strong>Recommended check:</strong> ${escapeHtml(alert.action)}</div>
      <div class="alert-footer"><span>${escapeHtml(alert.evidence)}</span><span>${escapeHtml(alert.caveat)}</span>${alert.note ? `<button class="text-button" type="button" data-building="${escapeHtml(alert.buildingId)}">Open building evidence →</button>` : ""}</div></div>
      <button class="ack-button ${done ? "is-done" : ""}" type="button" data-ack-alert="${escapeHtml(alert.id)}" aria-pressed="${done}">${alert.resolved ? "Repair recorded" : done ? "Reviewed" : "Mark reviewed"}</button>
    </article>`;
  }).join("") : `<div class="empty-card">No historical candidates have occurred by this replay time. Move the replay slider forward to review evidence.</div>`;
}

function resourceValue(row, resource) {
  if (resource === "waste_kg") return dailyWaste(row);
  const value = row?.[resource];
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function renderImpact() {
  const resource = $("impact-resource").value;
  const days = app.data.calendar.map((row) => dateKey(row.date)).filter((day) => day < cursorDate()).sort();
  const recentDays = days.slice(-7);
  const baselineDays = days.slice(-35, -7);
  const unit = resource === "electricity_kwh" ? "kWh" : resource === "water_litres" ? "L" : "kg";
  const scores = app.data.buildings.map((building) => {
    const summarize = (windowDays) => {
      const rows = app.data.daily.filter((row) => row.building_id === building.building_id && windowDays.includes(dateKey(row.date)));
      const eligible = rows.filter((row) => resourceValue(row, resource) !== null && Number(row.occupancy_avg) > 0);
      const totalResource = eligible.reduce((sum, row) => sum + resourceValue(row, resource), 0);
      const occupantDays = eligible.reduce((sum, row) => sum + Number(row.occupancy_avg), 0);
      return { rate: occupantDays > 0 ? totalResource / occupantDays : null, count: eligible.length, occupantDays };
    };
    const recent = summarize(recentDays);
    const baseline = summarize(baselineDays);
    const change = recent.count >= 6 && baseline.count >= 22 && recent.rate !== null && baseline.rate > 0 ? (recent.rate / baseline.rate - 1) * 100 : null;
    const reduction = change === null ? null : Math.max(0, -change);
    return { building, recent, baseline, change, credits: reduction === null ? null : Math.min(100, Math.floor(reduction)) };
  }).sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1));
  $("impact-leaderboard").innerHTML = scores.map((item, index) => {
    const usable = item.change !== null;
    const progress = usable ? Math.min(100, Math.max(0, -item.change)) : 0;
    const changeLabel = usable ? `${item.change > 0 ? "+" : ""}${fmtNumber(item.change, 1)}%` : "Unavailable";
    const note = `${item.recent.count}/7 recent days · ${item.baseline.count}/28 baseline days · ${fmtNumber(item.recent.rate, 3)} ${unit}/occupant-day`;
    return `<div class="impact-row"><span class="impact-rank">${index + 1}</span><div class="impact-building"><strong>${escapeHtml(item.building.building_id)} · ${escapeHtml(item.building.building_name)}</strong><small>${escapeHtml(note)}</small></div><div class="impact-bar-block"><div class="impact-bar-label"><span>Change vs own baseline</span><span>${escapeHtml(changeLabel)}</span></div><div class="impact-bar-track" role="img" aria-label="${escapeHtml(usable ? `${fmtNumber(progress, 1)} percent reduction against baseline` : "Insufficient data")}"><i style="width:${progress}%"></i></div></div><div class="impact-rate"><span>Baseline</span><strong>${fmtNumber(item.baseline.rate, 3)} ${unit}/person-day</strong></div><div class="credit-score"><span>Illustrative credits</span><strong>${item.credits === null ? "—" : item.credits}</strong>${usable && item.change > 0 ? "Use increased" : "No credits issued"}</div></div>`;
  }).join("") || `<div class="empty-card">No complete days are available before this replay time.</div>`;
}

function renderMethods() {
  if (app.health) {
    $("api-health-chip").textContent = `Service status · ${app.health.status}`;
    const relation = app.data.relations;
    const rows = [
      ["Hourly capture keys", `${integerFormat.format(relation.hourly_unique_keys)} / ${integerFormat.format(relation.hourly_expected)} expected`],
      ["Missing capture keys", integerFormat.format(relation.hourly_missing_keys)],
      ["Duplicate capture groups", `${integerFormat.format(relation.hourly_duplicate_groups)} · revisions preserved`],
      ["Possible noisy hourly values", integerFormat.format(relation.hourly_possible_noisy_values ?? 0)],
      ["Daily summary rows", `${integerFormat.format(relation.daily_rows)} / ${integerFormat.format(relation.daily_expected)} expected`],
      ["Manual aliases mapped", `${integerFormat.format(relation.mapped_manual_logs)} / ${integerFormat.format(relation.manual_logs)}`],
      ["Last benchmark arrival", formatDateTime(app.data.benchmark.latest_hourly_arrival)],
    ];
    const buildings = app.data.buildings.map((building) => {
      const freshness = freshnessFor(building.building_id);
      return `<div class="health-building"><span>${escapeHtml(building.building_id)}</span><strong>${escapeHtml(building.building_name)}</strong><span class="status-pill"><i class="status-dot ${statusDotClass(freshness.status)}"></i>${escapeHtml(freshness.label)}</span></div>`;
    }).join("");
    $("health-summary").innerHTML = `<div class="health-list">${rows.map(([name, value]) => `<div class="health-row"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div><div class="health-buildings">${buildings}</div>`;
  }
  const sources = app.data.sources ?? [
    { file: "buildings.xlsx", sheet: "buildings", rows: 8, missing: {} },
    { file: "calendar.xlsx", sheet: "calendar", rows: 120, missing: { event: 73 } },
    { file: "daily_summary.xlsx", sheet: "daily_summary", rows: 960, missing: { occupancy_avg: 5, electricity_kwh: 11, water_litres: 11, wet_organic_kg: 9 } },
    { file: "hourly_streams.xlsx", sheet: "hourly_streams", rows: 23192, missing: { electricity_kwh: 69, water_litres: 69, footfall: 69 } },
    { file: "manual_logs.xlsx", sheet: "manual_logs", rows: 415, missing: { value: 13, unit: 13, note: 148 } },
    { file: "waste_events_train.xlsx", sheet: "waste_events_train", rows: 6314, missing: { weight_g: 127, moisture_pct: 129, metal_signal: 125, transparency: 116, acoustic_hardness: 123 } },
    { file: "waste_events_test.xlsx", sheet: "waste_events_test", rows: 1601, missing: { weight_g: 31, moisture_pct: 29, metal_signal: 33, transparency: 42, acoustic_hardness: 35 } },
  ];
  $("source-summary").innerHTML = sources.length ? sources.map((source) => {
    const missing = Object.entries(source.missing ?? {}).map(([field, count]) => `${field}: ${count}`).join(", ") || "no missing cells";
    return `<button type="button" class="source-summary-row source-summary-button" data-source-file="${escapeHtml(source.file)}" data-source-sheet="${escapeHtml(source.sheet)}" data-source-row="2"><strong>${escapeHtml(source.file)}</strong><span>${integerFormat.format(source.rows)} rows</span><span>${escapeHtml(missing)}</span></button>`;
  }).join("") : `<div class="empty-card">Workbook inventory is unavailable until source data are prepared.</div>`;
  if (app.forecast?.evaluation) {
    const report = app.forecast.evaluation;
    $("forecast-evaluation").innerHTML = [6, 12].map((horizon) => {
      const result = report[String(horizon)];
      return `<div class="forecast-eval-row"><strong>+${horizon} h</strong><span>Ridge MAE ${fmtNumber(result.ridge.mae, 2)} kWh · RMSE ${fmtNumber(result.ridge.rmse, 2)} · WAPE ${fmtPercent(result.ridge.wape_pct, 2)}</span><span>Baseline MAE ${fmtNumber(result.seasonal_naive.mae, 2)} · p90 abs error ±${fmtNumber(result.ridge_validation_abs_error_p90_kwh, 2)} kWh</span></div>`;
    }).join("");
  }
}

function renderAll() {
  if (!app.data) return;
  const candidateCount = app.alerts.filter((alert) => alert.date <= cursorDate()).length;
  $("nav-alert-count").textContent = String(candidateCount);
  if (app.activeView === "overview") renderOverview();
  else if (app.activeView === "campus") renderCampus();
  else if (app.activeView === "buildings") renderBuildingDetail();
  else if (app.activeView === "waste") renderWaste();
  else if (app.activeView === "alerts") renderAlerts();
  else if (app.activeView === "impact") renderImpact();
  else if (app.activeView === "methods") renderMethods();
}

function showLoadError(error) {
  $("loading-state").hidden = true;
  $("app-content").hidden = true;
  $("error-state").hidden = false;
  $("error-message").textContent = error.message || "The service did not respond. Check your connection and retry.";
}

async function loadApp() {
  $("loading-state").hidden = false;
  $("error-state").hidden = true;
  try {
    const [data, waste, forecast, health, demo] = await Promise.all([
      api("/api/data"), api("/api/models/waste"), api("/api/models/forecast"), api("/api/health"), api("/api/demo/state"),
    ]);
    app.data = data;
    app.waste = waste;
    app.forecast = forecast;
    app.health = health;
    app.demo = demo;
    app.alerts = buildAlertCandidates();
    app.timeline = [];
    initTimeline();
    $("loading-state").hidden = true;
    $("error-state").hidden = true;
    $("app-content").hidden = false;
    const requested = location.hash.slice(1);
    if (["overview", "campus", "buildings", "waste", "alerts", "impact", "methods"].includes(requested)) app.activeView = requested;
    byClass(".view").forEach((view) => { view.hidden = view.id !== `view-${app.activeView}`; view.classList.toggle("is-visible", !view.hidden); });
    byClass(".nav-item").forEach((button) => {
      const active = button.dataset.view === app.activeView;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    $("replay-time").textContent = formatDateTime(currentCursor(), { year: "numeric" });
    renderAll();
  } catch (error) {
    showLoadError(error);
  }
}

function bindControls() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.view) { setView(target.dataset.view); return; }
    if (target.hasAttribute("data-brand-home")) { event.preventDefault(); setView("overview"); return; }
    if (target.dataset.campusResource) { app.campusResource = target.dataset.campusResource; renderCampus(); return; }
    if (target.dataset.mapBuilding) { app.selectedBuilding = target.dataset.mapBuilding; renderCampus(); return; }
    if (target.dataset.buildingSelect) { app.selectedBuilding = target.dataset.buildingSelect; renderBuildingDetail(); return; }
    if (target.dataset.building) {
      app.selectedBuilding = target.dataset.building;
      setView("buildings");
      return;
    }
    if (target.dataset.alertView) { setView("alerts"); requestAnimationFrame(() => $("alert-" + target.dataset.alertView)?.scrollIntoView({ block: "center", behavior: "smooth" })); return; }
    if (target.dataset.ackAlert) {
      const ids = acknowledgedAlertIds();
      ids.add(target.dataset.ackAlert);
      localStorage.setItem("campulse-acknowledged-alerts", JSON.stringify([...ids]));
      renderAlerts();
      return;
    }
    if (target.id === "play-button") { togglePlayback(); return; }
    if (target.id === "reset-demo") {
      app.playing = false; clearInterval(app.timer); app.timer = null; updatePlayButton();
      const result = await api("/api/demo/reset", { method: "POST", body: "{}" });
      app.demo = result.state; localStorage.removeItem("campulse-acknowledged-alerts"); updateCursor(app.timeline.length - 1); setToast("Simulation and alert review state reset for this browser."); return;
    }
    if (target.id === "offline-toggle") {
      const isOffline = app.demo.offline.some((row) => row.building_id === app.selectedBuilding);
      const endpoint = isOffline ? "/api/demo/reconnect" : "/api/demo/offline";
      const result = await api(endpoint, { method: "POST", body: JSON.stringify({ buildingId: app.selectedBuilding, cursor: currentCursor() }) });
      app.demo = isOffline ? result.state : result.state;
      if (isOffline) setToast(`Reconnected ${app.selectedBuilding}; reconciled ${integerFormat.format(result.reconciledRows)} queued captures and deduplicated ${integerFormat.format(result.deduplicatedRows)} repeated source rows.`);
      else setToast(`${app.selectedBuilding} is marked offline. Later arrivals will queue until reconnection.`);
      renderAll(); return;
    }
    if (target.id === "retry-load") { await loadApp(); return; }
    if (target.id === "clear-sensors") { $("classify-form").reset(); $("inference-result").innerHTML = ""; return; }
    if (target.id === "close-source-dialog") { $("source-dialog").close(); return; }
    if (target.hasAttribute("data-source-row")) {
      const params = new URLSearchParams({ file: target.dataset.sourceFile, sheet: target.dataset.sourceSheet, row: target.dataset.sourceRow });
      try {
        const source = await api(`/api/source?${params}`);
        $("source-dialog-title").textContent = `${source.sourceFile} · ${source.sourceSheet} · row ${source.sourceRow}`;
        $("source-dialog-description").textContent = "Values as stored in the original read-only workbook. Normalized values and quality flags are shown in the detail view.";
        $("source-dialog-values").textContent = JSON.stringify(source.values, null, 2);
        $("source-dialog").showModal();
      } catch (error) { setToast(`Source row could not be opened: ${error.message}`, "error"); }
    }
  });
  $("playback-slider").addEventListener("input", (event) => updateCursor(event.target.value, true));
  $("speed-select").addEventListener("change", () => { if (app.playing) startPlaybackTimer(); });
  $("overview-resource").addEventListener("change", () => renderOverview());
  $("building-resource").addEventListener("change", renderBuildingDetail);
  $("impact-resource").addEventListener("change", renderImpact);
  $("waste-class-filter").addEventListener("change", (event) => { app.selectedWasteClass = event.target.value; renderWaste(); });
  $("waste-test-event").addEventListener("change", renderWastePreview);
  $("classify-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const features = Object.fromEntries(["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"].map((name) => [name, form.get(name) === "" ? null : Number(form.get(name))]));
    $("inference-result").textContent = "Classifying locally…";
    try {
      const result = await api("/api/classify", { method: "POST", body: JSON.stringify({ features }) });
      const scores = Object.entries(result.scores).sort((a, b) => b[1] - a[1]).map(([name, score]) => `<div class="score-row" role="listitem"><span>${escapeHtml(shortClass(name))}</span><span class="score-track"><i style="width:${Math.max(0, Math.min(100, score * 100))}%"></i></span><b>${fmtPercent(score * 100, 1)}</b></div>`).join("");
      $("inference-result").innerHTML = `<div class="inference-card ${result.needsReview ? "needs-review" : ""}"><span>Predicted benchmark class</span><strong>${escapeHtml(result.predictedClass.replaceAll("_", " "))}</strong><small>${result.needsReview ? "Review recommended: low margin or incomplete sensors." : "No review threshold triggered."} ${result.imputedFeatures.length ? `Median-imputed: ${escapeHtml(result.imputedFeatures.join(", "))}.` : "All five sensor values supplied."}</small><small>${fmtNumber(result.latencyMs, 3)} ms this request · local CPU</small><div class="score-bars" role="list" aria-label="Relative model vote scores, not calibrated probabilities">${scores}</div><em>Scores are relative model votes, not calibrated probabilities.</em></div>`;
    } catch (error) { $("inference-result").innerHTML = `<div class="empty-card is-error">${escapeHtml(error.message)}</div>`; }
  });
  $("source-dialog").addEventListener("click", (event) => {
    if (event.target === $("source-dialog")) $("source-dialog").close();
  });
}

bindControls();
loadApp();

