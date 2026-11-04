import { buildAircraftMesh } from './mesh.js';
import { fetchFeed, findAirport, loadRunways } from './data.js';

const { MapboxOverlay, SimpleMeshLayer, PathLayer, LineLayer, TextLayer, ScatterplotLayer } = deck;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NM = 1852;           // metres per nautical mile
const FT = 0.3048;         // metres per foot
const KT = NM / 3600;      // m/s per knot
const R_EARTH = 6371008.8;
const POLL_MS = 15000;     // VATSIM feed refreshes every 15 s
const MAX_EXTRAP_S = 30;   // don't dead-reckon further than this past the last report
const BLEND_MS = 2000;     // smoothing window when a new report corrects our prediction
const TRAIL_POINTS = 60;   // ~15 min of history at 15 s
const GROUND_GS = 45;      // kt — below this and near field elevation → on ground

const COLORS = {
  dep: [255, 159, 67],
  arr: [58, 209, 255],
  local: [199, 146, 255],
  other: [215, 221, 229],
  selected: [255, 233, 74],
};

const BASEMAPS = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  satellite: rasterStyle(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'Imagery © Esri, Maxar, Earthstar Geographics'),
  osm: rasterStyle(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
};

function rasterStyle(url, attribution) {
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  airport: null,          // { icao, name, lat, lon, fir, atcPrefixes, elevFt }
  runways: [],
  radiusNm: 40,
  exag: 1,
  size: 1,
  show: { labels: true, trails: true, stalks: true, rings: true, ground: true },
  aircraft: new Map(),    // callsign -> aircraft record
  atc: [],
  selected: null,
  follow: false,
  clockOffset: 0,         // local clock minus VATSIM clock (ms)
  lastFeed: null,
  pollTimer: null,
};

const MESH = buildAircraftMesh();
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const rad = (d) => (d * Math.PI) / 180;

function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return (2 * R_EARTH * Math.asin(Math.sqrt(a))) / NM;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Move a point `distM` metres along `hdgDeg` (flat-earth; fine for a few km). */
function offset(lat, lon, hdgDeg, distM) {
  const h = rad(hdgDeg);
  return [
    lat + ((distM * Math.cos(h)) / R_EARTH) * (180 / Math.PI),
    lon + ((distM * Math.sin(h)) / (R_EARTH * Math.cos(rad(lat)))) * (180 / Math.PI),
  ];
}

function circle(lat, lon, radiusM, steps = 128) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const [la, lo] = offset(lat, lon, (i / steps) * 360, radiusM);
    pts.push([lo, la]);
  }
  return pts;
}

function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }

// ---------------------------------------------------------------------------
// Aircraft model: last report + dead reckoning + smoothing
// ---------------------------------------------------------------------------
function fieldElevFt() { return state.airport?.elevFt ?? 0; }

function category(fp, icao) {
  if (!fp) return 'other';
  const dep = fp.departure === icao;
  const arr = fp.arrival === icao;
  if (dep && arr) return 'local';
  if (dep) return 'dep';
  if (arr) return 'arr';
  return 'other';
}

/** Raw dead-reckoned position at local time `now` (no smoothing). */
function predictRaw(ac, now) {
  const b = ac.base;
  const dt = Math.min(Math.max((now - b.t) / 1000, 0), MAX_EXTRAP_S);
  let lat = b.lat, lon = b.lon, alt = b.alt;
  if (b.gs > 2) {
    const turned = ac.turnRate * dt; // deg
    const hdg = b.hdg + turned / 2;  // mid-arc heading
    [lat, lon] = offset(b.lat, b.lon, hdg, b.gs * KT * dt);
  }
  if (!ac.onGround) alt = Math.max(fieldElevFt(), b.alt + (ac.vs / 60) * dt);
  return { lat, lon, alt, hdg: (b.hdg + ac.turnRate * dt + 360) % 360 };
}

/** Smoothed position: prediction plus a correction that fades out over BLEND_MS. */
function predict(ac, now) {
  const p = predictRaw(ac, now);
  const c = ac.corr;
  if (c) {
    const k = 1 - (now - c.t0) / BLEND_MS;
    if (k > 0) {
      p.lat += c.lat * k; p.lon += c.lon * k; p.alt += c.alt * k;
      p.hdg = (p.hdg + c.hdg * k + 360) % 360;
    } else ac.corr = null;
  }
  return p;
}

function heightM(altFt, onGround) {
  if (onGround) return 0;
  return Math.max(0, altFt - fieldElevFt()) * FT * state.exag;
}

function ingestFeed(feed) {
  const ap = state.airport;
  if (!ap) return;
  const now = Date.now();
  state.clockOffset = now - Date.parse(feed.general.update_timestamp);
  const keepRadius = state.radiusNm + 5; // hysteresis so edge traffic doesn't flicker
  const seen = new Set();

  for (const p of feed.pilots) {
    const d = distanceNm(ap.lat, ap.lon, p.latitude, p.longitude);
    const existing = state.aircraft.get(p.callsign);
    if (d > (existing ? keepRadius : state.radiusNm)) continue;
    seen.add(p.callsign);

    const t = Date.parse(p.last_updated) + state.clockOffset;
    const onGround = p.groundspeed < GROUND_GS && p.altitude - fieldElevFt() < 300;
    const fp = p.flight_plan;
    const base = { lat: p.latitude, lon: p.longitude, alt: p.altitude, hdg: p.heading, gs: p.groundspeed, t };

    let ac = existing;
    if (!ac) {
      ac = { callsign: p.callsign, history: [], vs: 0, turnRate: 0, corr: null };
      state.aircraft.set(p.callsign, ac);
    } else if (t > ac.base.t) {
      // Smooth: remember where we were drawing it, then fade into the new prediction.
      const before = predict(ac, now);
      const dtMin = (t - ac.base.t) / 60000;
      const vsNew = (p.altitude - ac.base.alt) / dtMin;
      ac.vs = Math.abs(vsNew) < 8000 ? ac.vs * 0.3 + vsNew * 0.7 : 0;
      const tr = angleDiff(ac.base.hdg, p.heading) / (dtMin * 60);
      ac.turnRate = Math.abs(tr) < 6 ? tr : 0;
      ac.base = base;
      ac.onGround = onGround;
      if (onGround) { ac.vs = 0; }
      if (p.groundspeed < 5) ac.turnRate = 0;
      const after = predictRaw(ac, now);
      const jumpNm = distanceNm(before.lat, before.lon, after.lat, after.lon);
      ac.corr = jumpNm < 1.5
        ? { lat: before.lat - after.lat, lon: before.lon - after.lon, alt: before.alt - after.alt, hdg: angleDiff(after.hdg, before.hdg), t0: now }
        : null;
    }
    ac.base = base;
    ac.onGround = onGround;
    ac.cid = p.cid;
    ac.name = p.name;
    ac.squawk = p.transponder;
    ac.dep = fp?.departure || '';
    ac.arr = fp?.arrival || '';
    ac.type = fp?.aircraft_short || fp?.aircraft_faa || '';
    ac.rules = fp?.flight_rules || '';
    ac.cruise = fp?.altitude || '';
    ac.route = fp?.route || '';
    ac.cat = category(fp, ap.icao);
    ac.distNm = d;

    const last = ac.history[ac.history.length - 1];
    if (!last || last.t !== t) {
      ac.history.push({ lat: p.latitude, lon: p.longitude, alt: p.altitude, onGround, t });
      if (ac.history.length > TRAIL_POINTS) ac.history.shift();
    }
  }

  for (const cs of state.aircraft.keys()) if (!seen.has(cs)) state.aircraft.delete(cs);
  if (state.selected && !state.aircraft.has(state.selected)) select(null);

  // ATC: controllers whose callsign prefix matches the airport, its IATA code or its FIR.
  const prefixes = ap.atcPrefixes;
  const atc = feed.controllers
    .filter((c) => c.facility > 0 && prefixes.has(c.callsign.split('_')[0].toUpperCase()))
    .map((c) => ({ callsign: c.callsign, freq: c.frequency, name: c.name, atis: null }));
  for (const a of feed.atis || []) {
    if (a.callsign.split('_')[0].toUpperCase() === ap.icao) {
      atc.push({ callsign: a.callsign, freq: a.frequency, name: a.name, atis: (a.text_atis || []).join(' '), code: a.atis_code });
    }
  }
  state.atc = atc.sort((a, b) => atcRank(a.callsign) - atcRank(b.callsign) || a.callsign.localeCompare(b.callsign));
  state.lastFeed = feed.general.update_timestamp;
  renderSidebar();
}

function atcRank(cs) {
  const order = ['ATIS', 'DEL', 'GND', 'TWR', 'APP', 'DEP', 'CTR', 'FSS'];
  const i = order.indexOf(cs.split('_').pop());
  return i < 0 ? 99 : i;
}

async function poll() {
  clearTimeout(state.pollTimer);
  try {
    const feed = await fetchFeed();
    ingestFeed(feed);
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus(`Feed error: ${err.message}. Retrying…`);
  }
  state.pollTimer = setTimeout(poll, POLL_MS);
}

// ---------------------------------------------------------------------------
// Map + deck.gl
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAPS.dark,
  center: [-0.461389, 51.4775],
  zoom: 9.6,
  pitch: 62,
  bearing: -25,
  maxPitch: 85,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');

const overlay = new MapboxOverlay({
  interleaved: false,
  layers: [],
  getTooltip: ({ object, layer }) => {
    if (!object || !layer || !['aircraft', 'labels', 'pick'].includes(layer.id)) return null;
    const ac = object.ac || object;
    return { text: `${ac.callsign}  ${ac.type || ''}\n${ac.dep || '----'} → ${ac.arr || '----'}\n${formatAlt(ac.base.alt)}  ${ac.base.gs} kt` };
  },
  onClick: ({ object, layer }) => {
    if (object && layer && ['aircraft', 'labels', 'pick'].includes(layer.id)) select((object.ac || object).callsign);
  },
});
map.addControl(overlay);
map.on('dragstart', () => { if (state.follow) setFollow(false); });

// Keep the airport centred in the visible area, not behind the side panel.
function updatePadding() {
  const panel = $('panel');
  const wide = window.innerWidth > 640 && !panel.classList.contains('hidden');
  map.setPadding({ left: wide ? panel.offsetWidth + 12 : 0, top: 0, right: 0, bottom: 0 });
}
updatePadding();
window.addEventListener('resize', updatePadding);

function metresPerPixel() {
  return (40075016.686 * Math.cos(rad(map.getCenter().lat))) / (512 * 2 ** map.getZoom());
}

function colorOf(ac, alpha = 255) {
  const c = ac.callsign === state.selected ? COLORS.selected : COLORS[ac.cat] || COLORS.other;
  return [c[0], c[1], c[2], alpha];
}

function formatAlt(ft) {
  return ft >= 6000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${Math.round(ft / 10) * 10} ft`;
}

function buildLayers(now) {
  const ap = state.airport;
  if (!ap) return [];
  const list = [];
  for (const ac of state.aircraft.values()) {
    if (!state.show.ground && ac.onGround) continue;
    const p = predict(ac, now);
    const h = heightM(p.alt, ac.onGround);
    list.push({ ac, p, h, pos: [p.lon, p.lat, h] });
  }

  const layers = [];
  const airborne = list.filter((d) => !d.ac.onGround);

  if (state.show.rings) {
    const rings = [];
    for (let r = 10; r <= state.radiusNm; r += 10) rings.push({ r, path: circle(ap.lat, ap.lon, r * NM) });
    layers.push(new PathLayer({
      id: 'rings', data: rings, getPath: (d) => d.path, getColor: [120, 140, 165, 110],
      widthUnits: 'pixels', getWidth: 1,
    }));
    layers.push(new TextLayer({
      id: 'ring-labels', data: rings, getPosition: (d) => d.path[0], getText: (d) => `${d.r} NM`,
      getSize: 11, getColor: [150, 165, 185, 200], fontFamily: 'ui-monospace, Consolas, monospace',
      getPixelOffset: [0, -8],
    }));
  }

  // Runways (true width) plus faint 15 NM extended centrelines.
  if (state.runways.length) {
    const centrelines = [];
    for (const rw of state.runways) {
      const [lon1, lat1] = rw.lePos, [lon2, lat2] = rw.hePos;
      const brg = bearingDeg(lat1, lon1, lat2, lon2);
      const [aLat, aLon] = offset(lat1, lon1, brg + 180, 15 * NM);
      const [bLat, bLon] = offset(lat2, lon2, brg, 15 * NM);
      centrelines.push({ path: [[aLon, aLat], rw.lePos] }, { path: [rw.hePos, [bLon, bLat]] });
    }
    layers.push(new PathLayer({
      id: 'centrelines', data: centrelines, getPath: (d) => d.path, getColor: [90, 170, 220, 70],
      widthUnits: 'pixels', getWidth: 1,
    }));
    layers.push(new PathLayer({
      id: 'runways', data: state.runways, getPath: (d) => [d.lePos, d.hePos], getColor: [205, 214, 226, 230],
      widthUnits: 'meters', getWidth: (d) => d.widthM, widthMinPixels: 3, capRounded: false,
    }));
    const ends = state.runways.flatMap((r) => [{ t: r.le, p: r.lePos, o: r.hePos }, { t: r.he, p: r.hePos, o: r.lePos }]);
    layers.push(new TextLayer({
      id: 'runway-labels', data: ends,
      // Push each label slightly beyond its threshold.
      getPosition: (d) => { const b = bearingDeg(d.o[1], d.o[0], d.p[1], d.p[0]); const [la, lo] = offset(d.p[1], d.p[0], b, 350); return [lo, la]; },
      getText: (d) => d.t, getSize: 12, getColor: [230, 236, 244, 230], fontWeight: 700,
      fontFamily: 'ui-monospace, Consolas, monospace',
    }));
  }

  if (state.show.trails) {
    const trails = list
      .filter((d) => d.ac.history.length)
      .map((d) => ({
        ac: d.ac,
        path: [...d.ac.history.map((s) => [s.lon, s.lat, heightM(s.alt, s.onGround)]), d.pos],
      }));
    layers.push(new PathLayer({
      id: 'trails', data: trails, getPath: (d) => d.path, getColor: (d) => colorOf(d.ac, 150),
      widthUnits: 'pixels', getWidth: (d) => (d.ac.callsign === state.selected ? 3 : 1.6),
      jointRounded: true, updateTriggers: { getColor: state.selected, getWidth: state.selected },
    }));
  }

  if (state.show.stalks) {
    layers.push(new LineLayer({
      id: 'stalks', data: airborne, getSourcePosition: (d) => [d.p.lon, d.p.lat, 0], getTargetPosition: (d) => d.pos,
      getColor: (d) => colorOf(d.ac, 70), getWidth: 1, updateTriggers: { getColor: state.selected },
    }));
    layers.push(new ScatterplotLayer({
      id: 'shadows', data: airborne, getPosition: (d) => [d.p.lon, d.p.lat, 0], getRadius: 3,
      radiusUnits: 'pixels', getFillColor: (d) => colorOf(d.ac, 110), updateTriggers: { getFillColor: state.selected },
    }));
  }

  // Aircraft size: real-ish scale up close, but never smaller than ~26 px long when zoomed out.
  const scale = Math.max(55, metresPerPixel() * 26) * state.size;
  layers.push(new SimpleMeshLayer({
    id: 'aircraft', data: list, mesh: MESH, getPosition: (d) => d.pos,
    getOrientation: (d) => {
      const pitch = d.ac.onGround ? 0 : Math.max(-12, Math.min(15, (d.ac.vs / Math.max(d.ac.base.gs, 120)) * 0.6));
      const bank = d.ac.onGround ? 0 : Math.max(-25, Math.min(25, d.ac.turnRate * 8));
      return [pitch, -d.p.hdg, bank];
    },
    getColor: (d) => colorOf(d.ac), sizeScale: scale * (0.9),
    getScale: (d) => (d.ac.onGround ? [0.55, 0.55, 0.55] : [1, 1, 1]),
    pickable: true, material: { ambient: 0.45, diffuse: 0.65, shininess: 24, specularColor: [80, 80, 80] },
    updateTriggers: { getColor: state.selected },
  }));
  // Invisible, generous pick target so small aircraft are easy to click.
  layers.push(new ScatterplotLayer({
    id: 'pick', data: list, getPosition: (d) => d.pos, getRadius: 14, radiusUnits: 'pixels',
    getFillColor: [0, 0, 0, 0], pickable: true, billboard: true,
  }));

  if (state.show.labels) {
    // Ground traffic labels only once zoomed in enough to separate the stands.
    const groundLabels = map.getZoom() >= 12.5;
    layers.push(new TextLayer({
      id: 'labels', data: groundLabels ? list : airborne.concat(list.filter((d) => d.ac.callsign === state.selected && d.ac.onGround)), getPosition: (d) => d.pos, pickable: true,
      getText: (d) => (d.ac.onGround ? d.ac.callsign : `${d.ac.callsign}\n${formatAlt(d.p.alt)} ${d.ac.base.gs}kt`),
      getSize: (d) => (d.ac.onGround ? 10 : 12), getColor: (d) => colorOf(d.ac, 245),
      getPixelOffset: [0, -26], getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
      fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 600, lineHeight: 1.15,
      background: true, getBackgroundColor: [8, 12, 18, 170], backgroundPadding: [4, 2],
      parameters: { depthCompare: 'always' },
      updateTriggers: { getColor: state.selected, getText: Math.floor(now / 1000) },
    }));
  }
  return { layers, list };
}

let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 33) return; // ~30 fps is plenty
  lastFrame = now;
  const t = Date.now();
  const built = buildLayers(t);
  if (!built.layers) return;
  overlay.setProps({ layers: built.layers });

  if (state.follow && state.selected) {
    const d = built.list.find((x) => x.ac.callsign === state.selected);
    if (d) map.jumpTo({ center: [d.p.lon, d.p.lat], bearing: d.p.hdg });
  }
  if (state.selected) updateSelectedPanel(t);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function setStatus(msg) {
  const age = state.lastFeed ? Math.round((Date.now() - state.clockOffset - Date.parse(state.lastFeed)) / 1000) : null;
  $('status').textContent = msg || (age != null ? `Feed updated ${age}s ago · auto-refresh 15s` : 'Loading…');
}
setInterval(() => setStatus(''), 1000);

function renderSidebar() {
  const all = [...state.aircraft.values()];
  $('stat-air').textContent = all.filter((a) => !a.onGround).length;
  $('stat-gnd').textContent = all.filter((a) => a.onGround).length;
  $('stat-atc').textContent = state.atc.filter((a) => !a.atis).length;

  const atcList = $('atc-list');
  atcList.replaceChildren();
  if (!state.atc.length) atcList.append(li('No ATC online for this area', null, 'empty'));
  for (const a of state.atc) {
    const item = li(a.callsign + (a.code ? ` (${a.code})` : ''), a.freq);
    atcList.append(item);
    if (a.atis) {
      const t = document.createElement('li');
      t.className = 'atc-atis';
      t.textContent = a.atis;
      atcList.append(t);
    }
  }

  const traffic = $('traffic-list');
  traffic.replaceChildren();
  const sorted = all.sort((a, b) => a.onGround - b.onGround || a.distNm - b.distNm);
  if (!sorted.length) traffic.append(li('No traffic in range', null, 'empty'));
  for (const ac of sorted) {
    const right = ac.onGround ? `GND ${ac.dep || ''}→${ac.arr || ''}` : `${formatAlt(ac.base.alt)} ${ac.distNm.toFixed(0)}nm`;
    const item = li(ac.callsign, right, 'clickable');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `rgb(${(COLORS[ac.cat] || COLORS.other).join(',')})`;
    item.firstChild.prepend(dot);
    if (ac.callsign === state.selected) item.classList.add('sel');
    item.onclick = () => select(ac.callsign, true);
    traffic.append(item);
  }
}

function li(left, right, cls) {
  const el = document.createElement('li');
  if (cls) el.className = cls;
  const l = document.createElement('span');
  l.textContent = left;
  el.append(l);
  if (right != null) {
    const r = document.createElement('span');
    r.className = 'r';
    r.textContent = right;
    el.append(r);
  }
  return el;
}

function select(callsign, fly = false) {
  state.selected = callsign;
  if (!callsign) setFollow(false);
  $('selected').hidden = !callsign;
  renderSidebar();
  if (callsign && fly) flyToSelected();
}

function flyToSelected() {
  const ac = state.aircraft.get(state.selected);
  if (!ac) return;
  const p = predict(ac, Date.now());
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 11.5), pitch: 65, duration: 1200 });
}

function setFollow(on) {
  state.follow = on;
  $('sel-follow').classList.toggle('active', on);
  $('sel-follow').textContent = on ? 'Following' : 'Follow';
  if (on) map.easeTo({ zoom: Math.max(map.getZoom(), 11.5), pitch: 70, duration: 600 });
}

let lastPanelUpdate = 0;
function updateSelectedPanel(now) {
  if (now - lastPanelUpdate < 500) return;
  lastPanelUpdate = now;
  const ac = state.aircraft.get(state.selected);
  if (!ac) return;
  const p = predict(ac, now);
  $('sel-callsign').textContent = ac.callsign;
  $('sel-type').textContent = ac.type || 'no FP';
  $('sel-route').textContent = `${ac.dep || '----'} → ${ac.arr || '----'}`;
  const vs = ac.onGround ? 0 : Math.round(ac.vs / 50) * 50;
  const rows = [
    ['Alt', formatAlt(p.alt)], ['GS', `${ac.base.gs} kt`],
    ['Hdg', `${String(Math.round(p.hdg)).padStart(3, '0')}°`], ['V/S', `${vs > 0 ? '+' : ''}${vs} fpm`],
    ['Sqk', ac.squawk], ['Dist', `${distanceNm(state.airport.lat, state.airport.lon, p.lat, p.lon).toFixed(1)} nm`],
    ['Rules', ac.rules || '–'], ['Cruise', ac.cruise ? formatAlt(+ac.cruise) : '–'],
  ];
  const grid = $('sel-grid');
  grid.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    grid.append(dt, dd);
  }
  $('sel-grid').title = ac.route;
}

// ---------------------------------------------------------------------------
// Airport selection
// ---------------------------------------------------------------------------
async function setAirport(icao) {
  icao = icao.trim().toUpperCase();
  setStatus(`Looking up ${icao}…`);
  const ap = await findAirport(icao);
  if (!ap) { setStatus(`Unknown airport: ${icao}`); return; }
  state.airport = { ...ap, elevFt: 0 };
  state.aircraft.clear();
  state.runways = [];
  select(null);
  $('icao').value = ap.icao;
  $('airport-name').textContent = ap.name;
  document.title = `${ap.icao} · VATSIM 3D`;
  history.replaceState(null, '', `#${ap.icao}`);
  map.flyTo({ center: [ap.lon, ap.lat], zoom: 9.6, pitch: 62, bearing: -25, duration: 1500 });
  poll();

  const runways = await loadRunways(ap.icao);
  if (state.airport?.icao !== ap.icao) return;
  state.runways = runways;
  const elevs = runways.map((r) => r.elevFt).filter((e) => e != null);
  if (elevs.length) state.airport.elevFt = elevs.reduce((a, b) => a + b, 0) / elevs.length;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('airport-form').addEventListener('submit', (e) => { e.preventDefault(); setAirport($('icao').value); });

function bindRange(id, outId, fmt, apply) {
  const el = $(id);
  const update = () => { $(outId).textContent = fmt(+el.value); apply(+el.value); };
  el.addEventListener('input', update);
  update();
}
bindRange('radius', 'radius-out', (v) => `${v} NM`, (v) => {
  const changed = v !== state.radiusNm;
  state.radiusNm = v;
  if (changed) { clearTimeout(bindRange.t); bindRange.t = setTimeout(poll, 400); }
});
bindRange('exag', 'exag-out', (v) => `${v.toFixed(1)}×`, (v) => { state.exag = v; });
bindRange('size', 'size-out', (v) => `${v.toFixed(2)}×`, (v) => { state.size = v; });

for (const key of Object.keys(state.show)) {
  $(`t-${key}`).addEventListener('change', (e) => { state.show[key] = e.target.checked; });
}
$('basemap').addEventListener('change', (e) => map.setStyle(BASEMAPS[e.target.value]));
$('view-3d').onclick = () => state.airport && map.easeTo({ center: [state.airport.lon, state.airport.lat], zoom: 9.6, pitch: 62, bearing: -25, duration: 900 });
$('view-top').onclick = () => map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
$('sel-close').onclick = () => select(null);
$('sel-follow').onclick = () => setFollow(!state.follow);
$('sel-fly').onclick = flyToSelected;
$('collapse').onclick = () => { $('panel').classList.add('hidden'); $('expand').hidden = false; updatePadding(); };
$('expand').onclick = () => { $('panel').classList.remove('hidden'); $('expand').hidden = true; updatePadding(); };
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

setAirport((location.hash.slice(1) || 'EGLL').slice(0, 4));
