// Flight-path store for every pilot connected to VATSIM. Zero dependencies (Node 18+).
//
//   node server/tracks.mjs            # listens on 127.0.0.1:8787 (PORT / HOST to change)
//
// Every 15 s it reads the VATSIM Data API and appends each pilot's position to their flight:
//   - A flight is keyed by CID + callsign, so a reconnect under the same callsign continues it.
//   - Disconnected flights are kept for 1 hour. If the pilot comes back in that time, the next
//     point is flagged as a gap: the client draws a straight line from the last known point.
//   - Once a flight has landed (it was airborne, now it's on the ground at an airfield), it's
//     complete: if the pilot then disconnects, it's freed at once instead of after the hour.
//     If it takes off again under the same connection, a new flight starts.
// Points are thinned as they arrive (straight, level flight needs few points). The whole store
// is saved to disk every minute and on shutdown, so a restart doesn't lose paths.
//
// API (CORS-open, JSON):
//   GET /api/tracks?cs=BAW123,EZY45   paths of these callsigns, newest flight per callsign
//   GET /api/health                   counts, memory, last feed time
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const FEED_URL = process.env.FEED_URL || 'https://data.vatsim.net/v3/vatsim-data.json';
const AIRPORTS_URL = process.env.AIRPORTS_URL || 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const STORE_FILE = process.env.STORE_FILE || new URL('../data/tracks.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const POLL_MS = Number(process.env.POLL_MS) || 15_000;
const RECONNECT_BUFFER_MS = 60 * 60_000; // keep a disconnected, unfinished flight this long
const GAP_MS = 60_000;                   // missing from the feed longer than this → reconnect gap
const GROUND_GS = 45;                    // kt; same rule as the client
const GROUND_AGL_FT = 300;
const AIRFIELD_NM = 5;                   // "on the ground" needs an airfield within this distance
const MAX_POINTS = 4000;                 // per flight; thinned by half if exceeded
const SAVE_MS = 60_000;

// Point flags
const F_GAP = 1;     // reconnected: straight line from the previous point
const F_GROUND = 2;

/** key "cid:callsign" → flight */
const flights = new Map();
let lastFeedTs = '';
let lastPollOk = 0;

// ---------------------------------------------------------------------------
// Airfield elevations (OurAirports), on a 1° grid for nearest-field lookups.
// ---------------------------------------------------------------------------
const grid = new Map(); // "lat|lon" (floored) → [[lat, lon, elevFt], ...]

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

async function loadAirfields() {
  const r = await fetch(AIRPORTS_URL);
  if (!r.ok) throw new Error(`airports.csv ${r.status}`);
  const lines = (await r.text()).split('\n');
  const head = parseCsvLine(lines[0]);
  const iType = head.indexOf('type'), iLat = head.indexOf('latitude_deg'), iLon = head.indexOf('longitude_deg'), iEl = head.indexOf('elevation_ft');
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f[iType] === 'closed' || f[iEl] === '') continue;
    const lat = +f[iLat], lon = +f[iLon], el = +f[iEl];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(el)) continue;
    const k = `${Math.floor(lat)}|${Math.floor(lon)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([lat, lon, el]);
    n++;
  }
  console.log(`airfields: ${n} with elevations`);
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Elevation of the nearest airfield within AIRFIELD_NM, or null. */
function nearestFieldElev(lat, lon) {
  let best = null, bestD = AIRFIELD_NM;
  const la = Math.floor(lat), lo = Math.floor(lon);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const [a, b, el] of grid.get(`${la + dy}|${lo + dx}`) || []) {
      if (Math.abs(a - lat) > 0.1) continue;
      const d = distanceNm(lat, lon, a, b);
      if (d < bestD) { bestD = d; best = el; }
    }
  }
  return best;
}

function isOnGround(p) {
  if (p.groundspeed >= GROUND_GS) return false;
  const el = nearestFieldElev(p.latitude, p.longitude);
  return el !== null && p.altitude - el < GROUND_AGL_FT;
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------
const angleDiff = (a, b) => { const d = ((b - a + 540) % 360) - 180; return Math.abs(d); };

/** Store the point unless it adds nothing (thinning: straight and level needs few points). */
function addPoint(fl, pt, hdg) {
  const pts = fl.points;
  const last = pts[pts.length - 1];
  const [lon, lat, alt, t, flags] = pt;
  if (last && !(flags & F_GAP)) {
    const moved = distanceNm(last[1], last[0], lat, lon) * 1852; // metres
    const dt = t - last[3];
    const ground = flags & F_GROUND;
    const changedPhase = (last[4] & F_GROUND) !== ground;
    const turned = angleDiff(fl.lastHdg ?? hdg, hdg);
    const climbed = Math.abs(alt - last[2]);
    if (!changedPhase) {
      if (moved < 15 && climbed < 50) return;                                      // parked / holding still
      const keep = ground ? (turned >= 8 || dt >= 60) : (turned >= 3 || climbed >= 250 || dt >= 120);
      if (!keep) return;
    }
  }
  pts.push(pt);
  fl.lastHdg = hdg;
  if (pts.length > MAX_POINTS) fl.points = pts.filter((p, i) => i % 2 === 0 || p[4] & F_GAP || i === pts.length - 1);
}

function ingest(feed) {
  const now = Date.now();
  const seen = new Set();
  for (const p of feed.pilots) {
    const key = `${p.cid}:${p.callsign}`;
    seen.add(key);
    const t = Math.round(Date.parse(p.last_updated) / 1000);
    const ground = isOnGround(p);
    let fl = flights.get(key);
    let gap = false;
    if (!fl) {
      fl = { cid: p.cid, callsign: p.callsign, points: [], airborne: false, landed: false, groundCount: 0, lastSeen: now, start: now };
      flights.set(key, fl);
    } else if (t - fl.lastT > GAP_MS / 1000) {
      gap = true; // reconnected within the buffer (or reports stopped for a while)
    }
    fl.lastSeen = now;
    fl.lastT = t;
    fl.connected = true;
    fl.dep = p.flight_plan?.departure || '';
    fl.arr = p.flight_plan?.arrival || '';
    fl.type = (p.flight_plan?.aircraft_short || '').split('/')[0];

    if (!ground) {
      if (fl.landed) {
        // Took off again after landing: that's a new flight. Start from the last ground point.
        const lastGround = fl.points[fl.points.length - 1];
        fl.points = lastGround ? [[...lastGround.slice(0, 4), F_GROUND]] : [];
        fl.landed = false;
        fl.start = now;
      }
      fl.airborne = true;
      fl.groundCount = 0;
    } else if (fl.airborne) {
      // Two ground reports in a row after being airborne = landed (one could be a glitch).
      if (++fl.groundCount >= 2) fl.landed = true;
    }
    addPoint(fl, [+p.longitude.toFixed(5), +p.latitude.toFixed(5), p.altitude, t, (gap ? F_GAP : 0) | (ground ? F_GROUND : 0)], p.heading);
  }

  // Disconnected flights: free completed ones at once, keep the rest for the reconnect buffer.
  for (const [key, fl] of flights) {
    if (seen.has(key)) continue;
    fl.connected = false;
    if (fl.landed || now - fl.lastSeen > RECONNECT_BUFFER_MS) flights.delete(key);
  }
}

async function poll() {
  try {
    const r = await fetch(FEED_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const feed = await r.json();
    if (feed.general.update_timestamp !== lastFeedTs) {
      lastFeedTs = feed.general.update_timestamp;
      ingest(feed);
    }
    lastPollOk = Date.now();
  } catch (e) {
    console.warn(`poll failed: ${e.message}`);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function save() {
  try {
    await mkdir(dirname(STORE_FILE), { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), flights: [...flights.values()] }));
    await rename(tmp, STORE_FILE);
  } catch (e) { console.warn(`save failed: ${e.message}`); }
}

async function load() {
  try {
    const { savedAt, flights: list } = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    const now = Date.now();
    for (const fl of list) {
      if (now - fl.lastSeen > RECONNECT_BUFFER_MS) continue;
      if (fl.landed && !fl.connected) continue;
      // Gap detection uses the report time (lastT), so a quick restart doesn't create a gap.
      flights.set(`${fl.cid}:${fl.callsign}`, fl);
    }
    console.log(`restored ${flights.size} flights saved ${Math.round((now - savedAt) / 1000)} s ago`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`restore failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function tracksFor(callsigns) {
  // Newest flight per callsign (a callsign could briefly belong to two CIDs).
  const byCs = new Map();
  for (const fl of flights.values()) {
    if (!callsigns.has(fl.callsign)) continue;
    const cur = byCs.get(fl.callsign);
    if (!cur || fl.lastSeen > cur.lastSeen) byCs.set(fl.callsign, fl);
  }
  const out = {};
  for (const [cs, fl] of byCs) {
    out[cs] = { cid: fl.cid, dep: fl.dep, arr: fl.arr, type: fl.type, landed: fl.landed, connected: fl.connected, start: fl.start, points: fl.points };
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/api/tracks') {
    const cs = new Set((url.searchParams.get('cs') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 300));
    return send(res, 200, { now: Date.now(), feed: lastFeedTs, format: '[lon, lat, altFt, unixSec, flags] flags: 1 = reconnect gap, 2 = on ground', tracks: tracksFor(cs) });
  }
  if (url.pathname === '/api/health') {
    let points = 0, connected = 0;
    for (const fl of flights.values()) { points += fl.points.length; if (fl.connected) connected++; }
    return send(res, 200, {
      flights: flights.size, connected, buffered: flights.size - connected, points,
      rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1), feed: lastFeedTs, lastPollOk: new Date(lastPollOk).toISOString(),
    });
  }
  send(res, 404, { error: 'not found' });
});

await load();
await loadAirfields().catch((e) => console.warn(`airfields unavailable (${e.message}); ground detection off`));
poll();
setInterval(save, SAVE_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await save(); process.exit(0); });
server.listen(PORT, HOST, () => console.log(`tracks API on http://${HOST}:${PORT}`));
