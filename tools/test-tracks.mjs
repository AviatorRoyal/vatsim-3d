// Scenario test for server/tracks.mjs: serves a scripted fake VATSIM feed and checks
// reconnect gaps, landing → freed on disconnect, the 1 h buffer and new-flight-after-landing.
//   node tools/test-tracks.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const FEED_PORT = 8799, API_PORT = 8798, STEP_MS = 400;
const T0 = Date.parse('2026-11-04T12:00:00Z');
// One airfield at 51.47,-0.46, 83 ft (EGLL-ish).
const AIRPORTS = 'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft\n1,EGLL,large_airport,Test,51.47,-0.46,83\n';

const pilot = (cs, cid, lat, lon, alt, gs, hdg, step) => ({
  cid, callsign: cs, latitude: lat, longitude: lon, altitude: alt, groundspeed: gs, heading: hdg,
  last_updated: new Date(T0 + step * 15000).toISOString(), flight_plan: { departure: 'EGLL', arrival: 'EGCC', aircraft_short: 'A320' },
});
// Feed steps (each one 15 s of VATSIM time apart).
const steps = [];
for (let i = 0; i < 16; i++) {
  const ps = [];
  // GAP1: airborne, disconnects at steps 4–7, back at 8 (60 s+ later) → gap flag.
  if (i < 4 || i >= 8) ps.push(pilot('GAP1', 1, 52 + i * 0.05, 0, 30000 + i * 10, 450, (i * 10) % 360, i));
  // LAND1: airborne steps 0–4, on the ground at EGLL steps 5–8, disconnects at 9 → freed at once.
  if (i < 5) ps.push(pilot('LAND1', 2, 51.47 + (5 - i) * 0.02, -0.46, 500 + (5 - i) * 300, 150, 270, i));
  else if (i < 9) ps.push(pilot('LAND1', 2, 51.47, -0.46 - (i - 5) * 0.002, 83, 20, 270, i));
  // DROP1: airborne, disconnects at 6 → kept (buffered) as it hasn't landed.
  if (i < 6) ps.push(pilot('DROP1', 3, 48, 2 + i * 0.05, 35000, 460, 90, i));
  // TNG1: lands at 4–6 then takes off again at 7 → new flight starting at the last ground point.
  if (i < 4) ps.push(pilot('TNG1', 4, 51.47 + (4 - i) * 0.02, -0.46, 83 + (4 - i) * 400, 140, 180, i));
  else if (i < 7) ps.push(pilot('TNG1', 4, 51.47, -0.46, 83, 10, 180 + i * 20, i));
  else ps.push(pilot('TNG1', 4, 51.47 - (i - 6) * 0.02, -0.46, 83 + (i - 6) * 500, 160, 180, i));
  steps.push({ general: { update_timestamp: new Date(T0 + i * 15000).toISOString() }, pilots: ps, controllers: [] });
}

let step = -1;
const feedSrv = http.createServer((req, res) => {
  if (req.url.startsWith('/airports.csv')) return res.end(AIRPORTS);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(steps[Math.max(0, Math.min(step, steps.length - 1))]));
}).listen(FEED_PORT);

const store = new URL('../data/test-tracks.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await rm(store, { force: true });
const proc = spawn(process.execPath, [new URL('../server/tracks.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
  env: { ...process.env, PORT: API_PORT, FEED_URL: `http://127.0.0.1:${FEED_PORT}/feed`, AIRPORTS_URL: `http://127.0.0.1:${FEED_PORT}/airports.csv`, POLL_MS: String(STEP_MS / 4), STORE_FILE: store },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (q) => (await fetch(`http://127.0.0.1:${API_PORT}${q}`)).json();
await sleep(1500);

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const tracks = async () => (await api('/api/tracks?cs=GAP1,LAND1,DROP1,TNG1')).tracks;

let mid = null;
for (step = 0; step < steps.length; step++) {
  await sleep(STEP_MS);
  if (step === 9) mid = await tracks(); // LAND1 just disconnected after landing
}
const end = await tracks();

const gapPts = end.GAP1?.points || [];
const gapIdx = gapPts.findIndex((p) => p[4] & 1);
check('reconnect within the buffer continues the same path', !!end.GAP1 && gapPts[0][3] === T0 / 1000, `${gapPts.length} points`);
check('first point after reconnect is flagged as a gap', gapIdx > 0 && gapPts[gapIdx][3] === T0 / 1000 + 8 * 15, `gap at index ${gapIdx}`);
check('landed then disconnected → freed immediately', mid && !mid.LAND1 && !end.LAND1);
check('not landed, disconnected → kept for the reconnect buffer', end.DROP1 && end.DROP1.connected === false);
const tng = end.TNG1?.points || [];
check('take-off after landing starts a new flight', tng.length > 0 && tng[0][4] & 2 && tng[0][3] >= T0 / 1000 + 4 * 15 && !end.TNG1.landed, `first point flags ${tng[0]?.[4]}, ${tng.length} points`);
const health = await api('/api/health');
check('health counts', health.flights === 3 && health.buffered === 1, JSON.stringify(health));

proc.kill('SIGTERM');
feedSrv.close();
await sleep(300);
await rm(store, { force: true });
process.exit(results.every(Boolean) ? 0 : 1);
