import { buildAircraftMesh } from './mesh.js';
import { fetchFeed, findAirport, airportsNear } from './data.js';
import { loadModelRegistry, resolveModel, CLASS_LABELS } from './models.js';

const { MapboxOverlay, SimpleMeshLayer, ScenegraphLayer, PathLayer, LineLayer, TextLayer, ScatterplotLayer } = deck;

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
const MIN_RUNWAY_FT = 4000;   // nearby airfields shown automatically (smaller ones only when active)
const MAJOR_RUNWAY_FT = 6500; // gets a large label and extended centrelines
const MODEL_MIN_ZOOM = 11;    // detailed 3D models from this zoom in (approach / airport views)
const MODEL_EXIT_ZOOM = 10.5; // ...and back to simple shapes below this (hysteresis: no flip-flopping at 11)
const MAX_KEPT_MODELS = 12;   // loaded models kept on the GPU (hidden) so zooming back in is instant
const MAX_LIVE_MODELS = 8;    // distinct detailed models on the GPU at once

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
  airport: null,          // primary: { icao, name, lat, lon, fir, atcPrefixes, elevFt }
  nearby: new Map(),      // every airfield within the radius: icao -> { icao, name, lat, lon, distNm, runways, maxRunwayFt, elevFt }
  shown: [],              // the subset drawn on the map (significant or active)
  activity: new Map(),    // icao -> { dep, arr, gnd, atc }
  runways: [],
  radiusNm: 40,
  exag: 1,
  size: 1,
  show: { labels: true, trails: true, stalks: true, rings: true, ground: true, tint: false },
  quality: loadQuality(), // 'high' = detailed models when zoomed in, 'low' = simple shapes only
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

/**
 * Classify a flight against every airfield in range (not just the primary one).
 * If both ends are nearby (e.g. EGLL→EGKK), the end the aircraft is currently closer to wins.
 */
function category(fp, lat, lon) {
  if (!fp) return { cat: 'other', apt: null };
  const d = state.nearby.get(fp.departure);
  const a = state.nearby.get(fp.arrival);
  if (d && a) {
    if (d === a) return { cat: 'local', apt: d.icao };
    return distanceNm(lat, lon, d.lat, d.lon) <= distanceNm(lat, lon, a.lat, a.lon)
      ? { cat: 'dep', apt: d.icao }
      : { cat: 'arr', apt: a.icao };
  }
  if (d) return { cat: 'dep', apt: d.icao };
  if (a) return { cat: 'arr', apt: a.icao };
  return { cat: 'other', apt: null };
}

/** Elevation of the field an aircraft belongs to (or the nearest one), for on-ground detection. */
function refElevFt(apt, lat, lon) {
  const own = apt && state.nearby.get(apt);
  if (own) return own.elevFt;
  let best = null, bestD = Infinity;
  for (const ap of state.shown) {
    const dd = distanceNm(lat, lon, ap.lat, ap.lon);
    if (dd < bestD) { bestD = dd; best = ap; }
  }
  return best && bestD < 5 ? best.elevFt : fieldElevFt();
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
    const fp = p.flight_plan;
    const { cat, apt } = category(fp, p.latitude, p.longitude);
    const onGround = p.groundspeed < GROUND_GS && p.altitude - refElevFt(apt, p.latitude, p.longitude) < 300;
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
    ac.type = (fp?.aircraft_short || fp?.aircraft_faa || '').split('/')[0].trim().toUpperCase();
    ac.model = resolveModel(ac.type);
    ac.rules = fp?.flight_rules || '';
    ac.cruise = fp?.altitude || '';
    ac.route = fp?.route || '';
    ac.cat = cat;
    ac.apt = apt;
    ac.distNm = d;

    const last = ac.history[ac.history.length - 1];
    if (!last || last.t !== t) {
      ac.history.push({ lat: p.latitude, lon: p.longitude, alt: p.altitude, onGround, t });
      if (ac.history.length > TRAIL_POINTS) ac.history.shift();
    }
  }

  for (const cs of state.aircraft.keys()) if (!seen.has(cs)) state.aircraft.delete(cs);
  if (state.selected && !state.aircraft.has(state.selected)) select(null);

  // ATC: controllers for any airfield in range, plus the primary's IATA code and FIR (e.g. LON_, LTC_).
  const prefixOf = (cs) => cs.split('_')[0].toUpperCase();
  const isRelevant = (cs) => ap.atcPrefixes.has(prefixOf(cs)) || state.nearby.has(prefixOf(cs));
  const atc = feed.controllers
    .filter((c) => c.facility > 0 && isRelevant(c.callsign))
    .map((c) => ({ callsign: c.callsign, freq: c.frequency, name: c.name, atis: null }));
  for (const a of feed.atis || []) {
    if (state.nearby.has(prefixOf(a.callsign))) {
      atc.push({ callsign: a.callsign, freq: a.frequency, name: a.name, atis: (a.text_atis || []).join(' '), code: a.atis_code });
    }
  }
  // Primary airport first, then other fields by distance, then centre/FIR; within each, DEL→GND→TWR→APP→CTR.
  const groupRank = (cs) => {
    const p = prefixOf(cs);
    if (p === ap.icao) return -1;
    const n = state.nearby.get(p);
    return n ? n.distNm : 1e6;
  };
  state.atc = atc.sort((a, b) => groupRank(a.callsign) - groupRank(b.callsign)
    || atcRank(a.callsign) - atcRank(b.callsign) || a.callsign.localeCompare(b.callsign));
  state.lastFeed = feed.general.update_timestamp;

  // Activity per airfield, then decide which airfields to draw.
  const activity = new Map();
  const bump = (icao, key) => {
    if (!icao) return;
    const a = activity.get(icao) || { dep: 0, arr: 0, gnd: 0, atc: 0 };
    a[key]++;
    activity.set(icao, a);
  };
  for (const ac of state.aircraft.values()) {
    if (ac.onGround) bump(ac.apt, 'gnd');
    else if (ac.cat === 'dep' || ac.cat === 'local') bump(ac.apt, 'dep');
    else if (ac.cat === 'arr') bump(ac.apt, 'arr');
  }
  for (const a of atc) if (state.nearby.has(prefixOf(a.callsign))) bump(prefixOf(a.callsign), 'atc');
  state.activity = activity;
  updateShownAirports();
  renderSidebar();
}

/** Airfields to draw: the primary, every field with a decent runway, and any small field with traffic or ATC. */
function updateShownAirports() {
  const primary = state.airport?.icao;
  state.shown = [...state.nearby.values()].filter((a) =>
    a.icao === primary || a.maxRunwayFt >= MIN_RUNWAY_FT || state.activity.has(a.icao));
  state.runways = state.shown.flatMap((a) => a.runways.map((r) => ({ ...r, icao: a.icao, major: a.icao === primary || a.maxRunwayFt >= MAJOR_RUNWAY_FT })));
}

function isActive(icao) {
  const a = state.activity.get(icao);
  return !!a && a.dep + a.arr + a.gnd + a.atc > 0;
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
  onError: (err, layer) => console.error(`deck.gl error${layer ? ` in ${layer.id}` : ''}:`, err?.message || err),
  getTooltip: ({ object, layer }) => {
    if (object && layer?.id === 'airports') {
      const a = state.activity.get(object.icao);
      const act = a ? `\n${a.dep} dep · ${a.arr} arr · ${a.gnd} gnd · ${a.atc} ATC` : '\nno traffic';
      return { text: `${object.icao}  ${object.name}${act}${object.icao === state.airport?.icao ? '' : '\nclick to centre here'}` };
    }
    if (!object || !layer || !['aircraft', 'labels', 'pick'].includes(layer.id)) return null;
    const ac = object.ac || object;
    const typeName = ac.model?.typeName ? `\n${ac.model.typeName}` : '';
    return { text: `${ac.callsign}  ${ac.type || ''}${typeName}\n${ac.dep || '----'} → ${ac.arr || '----'}\n${formatAlt(ac.base.alt)}  ${ac.base.gs} kt` };
  },
  onClick: ({ object, layer }) => {
    if (object && layer?.id === 'airports') { if (object.icao !== state.airport?.icao) setAirport(object.icao); return; }
    if (object && layer && ['aircraft', 'labels', 'pick'].includes(layer.id)) select((object.ac || object).callsign);
  },
});
map.addControl(overlay);
// Explicit lights: without a LightingEffect, PBR-lit glTF models stop deck.gl drawing anything.
overlay.setProps({ effects: [new deck.LightingEffect({ amb: new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.2 }), sun: new deck.DirectionalLight({ color: [255, 250, 240], intensity: 2.0, direction: [-1, -2, -3] }) })] });
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

  // Runways (true width) for every shown airfield, plus faint extended centrelines at the major ones.
  if (state.runways.length) {
    const centrelines = [];
    for (const rw of state.runways) {
      if (!rw.major) continue;
      const [lon1, lat1] = rw.lePos, [lon2, lat2] = rw.hePos;
      const len = (rw.icao === ap.icao ? 15 : 10) * NM;
      const brg = bearingDeg(lat1, lon1, lat2, lon2);
      const [aLat, aLon] = offset(lat1, lon1, brg + 180, len);
      const [bLat, bLon] = offset(lat2, lon2, brg, len);
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
    // Runway numbers: always at the primary, elsewhere only once zoomed in.
    const showAllEnds = map.getZoom() >= 10.8;
    const ends = state.runways
      .filter((r) => showAllEnds || r.icao === ap.icao)
      .flatMap((r) => [{ t: r.le, p: r.lePos, o: r.hePos }, { t: r.he, p: r.hePos, o: r.lePos }]);
    layers.push(new TextLayer({
      id: 'runway-labels', data: ends,
      // Push each label slightly beyond its threshold.
      getPosition: (d) => { const b = bearingDeg(d.o[1], d.o[0], d.p[1], d.p[0]); const [la, lo] = offset(d.p[1], d.p[0], b, 350); return [lo, la]; },
      getText: (d) => d.t, getSize: 12, getColor: [230, 236, 244, 230], fontWeight: 700,
      fontFamily: 'ui-monospace, Consolas, monospace',
    }));
  }

  // Airfield name tags: bigger for the primary/major fields, brighter when there's traffic or ATC.
  if (state.shown.length) {
    const zoomedIn = map.getZoom() >= 10.8;
    layers.push(new TextLayer({
      id: 'airports', data: state.shown, pickable: true,
      getPosition: (d) => [d.lon, d.lat, 0],
      getText: (d) => d.icao,
      getSize: (d) => (d.icao === ap.icao ? 17 : d.maxRunwayFt >= MAJOR_RUNWAY_FT ? 14 : 11),
      getColor: (d) => (d.icao === ap.icao ? [255, 255, 255, 255] : isActive(d.icao) ? [120, 225, 255, 245] : [150, 162, 178, 190]),
      // Sit beside the field when zoomed out; above the runways when close in.
      getPixelOffset: zoomedIn ? [0, -40] : [0, -18],
      fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 700,
      background: true, getBackgroundColor: [8, 12, 18, 150], backgroundPadding: [4, 1],
      parameters: { depthCompare: 'always' },
      updateTriggers: { getColor: [state.airport?.icao, state.lastFeed], getSize: state.airport?.icao },
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

  // Size: true scale up close. Zoomed out, each aircraft is enlarged to stay visible, by an amount
  // that still keeps an A380 visibly bigger than a PA-28 (target length grows with √length).
  const mpp = metresPerPixel();
  const zoomScale = (lengthM, onGround) => {
    const targetPx = (16 + 14 * Math.sqrt(lengthM / 40)) * state.size;
    const k = Math.max(1, (mpp * targetPx) / lengthM);
    return onGround ? Math.max(1, k * 0.6) : k;
  };
  const orientation = (d) => {
    const pitch = d.ac.onGround ? 0 : Math.max(-12, Math.min(15, (d.ac.vs / Math.max(d.ac.base.gs, 120)) * 0.6));
    const bank = d.ac.onGround ? 0 : Math.max(-25, Math.min(25, d.ac.turnRate * 8));
    return [pitch, -d.p.hdg, bank];
  };

  // Level of detail. Detailed models cost GPU memory (textures + geometry per model), so they're
  // only used when zoomed in far enough to see them, for at most MAX_LIVE_MODELS distinct models
  // (the most common ones in view, plus the selected aircraft's). Everything else uses the
  // built-in low-poly mesh. A model layer that drops out of the list is freed by deck.gl.
  const z = map.getZoom();
  detailedOn = z >= MODEL_MIN_ZOOM || (detailedOn && z >= MODEL_EXIT_ZOOM);
  const detailed = detailedOn;
  const wanted = new Map(); // modelId -> count
  if (state.quality === 'high') {
    for (const d of list) {
      const id = d.ac.model?.modelId;
      if (id && (detailed || d.ac.callsign === state.selected)) wanted.set(id, (wanted.get(id) || 0) + 1);
    }
  }
  const selModel = state.selected && state.aircraft.get(state.selected)?.model?.modelId;
  const live = new Set([...wanted.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LIVE_MODELS).map(([id]) => id));
  if (selModel && wanted.has(selModel)) live.add(selModel);

  // A model layer draws nothing until deck.gl has downloaded and parsed its glTF, so until
  // then its aircraft are also drawn with the placeholder mesh (see modelLayersLoaded()).
  const byModel = new Map();
  const placeholder = [];
  for (const d of list) {
    const id = d.ac.model?.modelId;
    const eligible = id && live.has(id);
    if (eligible) {
      if (!byModel.has(id)) byModel.set(id, []);
      byModel.get(id).push(d);
    }
    if (!eligible || !loadedModels.has(id)) placeholder.push(d);
  }
  // Model layers that were in use recently stay alive with no data (and invisible), so their
  // parsed glTF, textures and shaders survive zooming out and back in. Least recently used go.
  for (const id of byModel.keys()) { keptModels.delete(id); keptModels.set(id, byModel.get(id)[0].ac.model); }
  while (keptModels.size > MAX_KEPT_MODELS) keptModels.delete(keptModels.keys().next().value);
  if (state.quality !== 'high') keptModels.clear();
  for (const [modelId, info] of keptModels) {
    const data = byModel.get(modelId) || NO_DATA;
    layers.push(new ScenegraphLayer({
      id: `model-${modelId}`, data, visible: data.length > 0, scenegraph: info.url, getPosition: (d) => d.pos,
      getOrientation: orientation,
      // Real model scale (metres) times the per-aircraft zoom enlargement.
      sizeScale: 1,
      getScale: (d) => { const k = zoomScale(info.lengthM, d.ac.onGround); return [k, k, k]; },
      // Untinted = the model's own livery; selected aircraft are always highlighted.
      getColor: (d) => (d.ac.callsign === state.selected ? [255, 236, 120, 255] : state.show.tint ? colorOf(d.ac) : [255, 255, 255, 255]),
      _lighting: 'pbr',
      updateTriggers: { getColor: [state.selected, state.show.tint], getScale: [Math.round(mpp * 10), state.size] },
    }));
  }
  if (placeholder.length) {
    layers.push(new SimpleMeshLayer({
      id: 'aircraft', data: placeholder, mesh: MESH, getPosition: (d) => d.pos,
      getOrientation: orientation,
      getColor: (d) => colorOf(d.ac), sizeScale: 1,
      getScale: (d) => { const L = d.ac.model?.lengthM || 35; const s = L * zoomScale(L, d.ac.onGround); return [s, s, s]; },
      pickable: true, material: { ambient: 0.45, diffuse: 0.65, shininess: 24, specularColor: [80, 80, 80] },
      updateTriggers: { getColor: state.selected, getScale: [Math.round(mpp * 10), state.size] },
    }));
  }
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

/** Model ids whose ScenegraphLayer has finished loading, read back from deck.gl after each frame. */
let loadedModels = new Set();
let detailedOn = false;          // zoom LOD state (with hysteresis)
const keptModels = new Map();    // modelId -> model info, in least-recently-used order
const NO_DATA = [];

function loadQuality() {
  const q = new URLSearchParams(location.search).get('quality'); // ?quality=low|high overrides
  if (q === 'low' || q === 'high') return q;
  try { return localStorage.getItem('vatsim3d.quality') === 'low' ? 'low' : 'high'; } catch { return 'high'; }
}
function setQuality(q) {
  state.quality = q;
  try { localStorage.setItem('vatsim3d.quality', q); } catch { /* private mode: not remembered */ }
  for (const b of document.querySelectorAll('#quality button')) b.setAttribute('aria-checked', String(b.dataset.q === q));
}
function modelLayersLoaded() {
  const lm = overlay._deck?.layerManager; // deck.gl's layer manager (instances, not descriptors)
  if (!lm) return loadedModels;
  const s = new Set();
  for (const layer of lm.getLayers()) {
    if (layer.id.startsWith('model-') && layer.isLoaded && layer.state?.scenegraph) s.add(layer.id.slice(6));
  }
  return s;
}

let lastFrame = 0;
// ?perf in the URL logs frame timing every 5 s (for checking zoomed-in smoothness).
const PERF = new URLSearchParams(location.search).has('perf') ? { n: 0, worst: 0, sum: 0, t0: performance.now(), prev: 0 } : null;
function frame(now) {
  requestAnimationFrame(frame);
  if (PERF) {
    if (PERF.prev) { const dt = now - PERF.prev; PERF.n++; PERF.sum += dt; PERF.worst = Math.max(PERF.worst, dt); }
    PERF.prev = now;
    if (now - PERF.t0 > 5000) {
      console.log(`perf z${map.getZoom().toFixed(1)} ${state.quality}: ${(1000 * PERF.n / (now - PERF.t0)).toFixed(0)} fps, avg ${(PERF.sum / PERF.n).toFixed(1)} ms, worst ${PERF.worst.toFixed(0)} ms, models loaded ${loadedModels.size}`);
      Object.assign(PERF, { n: 0, worst: 0, sum: 0, t0: now });
    }
  }
  if (now - lastFrame < 33) return; // ~30 fps is plenty
  lastFrame = now;
  const t = Date.now();
  const built = buildLayers(t);
  if (!built.layers) return;
  overlay.setProps({ layers: built.layers });
  loadedModels = modelLayersLoaded();

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

  // Nearby airfields: active ones first, then by distance. Click to make one the centre.
  const apList = $('airport-list');
  apList.replaceChildren();
  const fields = [...state.shown].sort((a, b) =>
    (b.icao === state.airport.icao) - (a.icao === state.airport.icao) || isActive(b.icao) - isActive(a.icao) || a.distNm - b.distNm);
  for (const f of fields) {
    const a = state.activity.get(f.icao);
    const parts = a ? [a.dep && `${a.dep}↑`, a.arr && `${a.arr}↓`, a.gnd && `${a.gnd} gnd`, a.atc && `${a.atc} ATC`].filter(Boolean) : [];
    const right = (parts.join(' ') || '–') + (f.icao === state.airport.icao ? '' : `  ${f.distNm.toFixed(0)}nm`);
    const item = li(f.icao, right, f.icao === state.airport.icao ? 'sel' : 'clickable');
    item.title = f.name;
    if (!isActive(f.icao)) item.classList.add('dim');
    if (f.icao !== state.airport.icao) item.onclick = () => setAirport(f.icao);
    apList.append(item);
  }

  const traffic = $('traffic-list');
  traffic.replaceChildren();
  const sorted = all.sort((a, b) => a.onGround - b.onGround || a.distNm - b.distNm);
  if (!sorted.length) traffic.append(li('No traffic in range', null, 'empty'));
  for (const ac of sorted) {
    const dir = ac.cat === 'arr' ? '↓' : ac.cat === 'dep' || ac.cat === 'local' ? '↑' : '';
    const right = ac.onGround
      ? `GND ${ac.apt || ''}`
      : `${formatAlt(ac.base.alt)} ${ac.apt ? dir + ac.apt : `${ac.distNm.toFixed(0)}nm`}`;
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

  // Which ICAO type / class this is, and whether we draw its own model or the class's generic one.
  const m = ac.model;
  $('sel-typename').textContent = m?.typeName || (ac.type ? 'Type not in ICAO Doc 8643' : 'No flight plan');
  $('sel-model').textContent = !m?.modelId ? ''
    : m.specific ? `3D model: ${m.modelName}`
    : `${CLASS_LABELS[m.cls] || m.cls} · generic model (${m.modelName})`;
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
  state.nearby = new Map();
  state.shown = [];
  state.runways = [];
  state.activity = new Map();
  select(null);
  $('icao').value = ap.icao;
  $('airport-name').textContent = ap.name;
  document.title = `${ap.icao} · VATSIM 3D`;
  history.replaceState(null, '', `#${ap.icao}`);
  // Optional ?zoom=&pitch=&bearing= for the first view (e.g. ?zoom=13 to start at the airport).
  const q = new URLSearchParams(location.search);
  const first = !setAirport.done;
  setAirport.done = true;
  map.flyTo({
    center: [ap.lon, ap.lat],
    zoom: first && q.has('zoom') ? +q.get('zoom') : 9.6,
    pitch: first && q.has('pitch') ? +q.get('pitch') : 62,
    bearing: first && q.has('bearing') ? +q.get('bearing') : -25,
    duration: first && q.has('zoom') ? 0 : 1500,
  });

  setStatus('Loading airfields and runways…');
  await refreshNearby();
  if (state.airport?.icao !== ap.icao) return;
  poll();
}

/** Re-scan airfields within the radius (on airport change or radius change). */
async function refreshNearby() {
  const ap = state.airport;
  if (!ap) return;
  const list = await airportsNear(ap.lat, ap.lon, state.radiusNm);
  if (state.airport !== ap) return;
  state.nearby = new Map(list.map((a) => [a.icao, a]));
  const self = state.nearby.get(ap.icao);
  if (self) state.airport.elevFt = self.elevFt;
  updateShownAirports();
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
  if (changed) { clearTimeout(bindRange.t); bindRange.t = setTimeout(() => refreshNearby().then(poll), 400); }
});
bindRange('exag', 'exag-out', (v) => `${v.toFixed(1)}×`, (v) => { state.exag = v; });
bindRange('size', 'size-out', (v) => `${v.toFixed(2)}×`, (v) => { state.size = v; });

for (const key of Object.keys(state.show)) {
  $(`t-${key}`).addEventListener('change', (e) => { state.show[key] = e.target.checked; });
}
for (const b of document.querySelectorAll('#quality button')) b.onclick = () => setQuality(b.dataset.q);
setQuality(state.quality);
$('basemap').addEventListener('change', (e) => map.setStyle(BASEMAPS[e.target.value]));
$('view-3d').onclick = () => state.airport && map.easeTo({ center: [state.airport.lon, state.airport.lat], zoom: 9.6, pitch: 62, bearing: -25, duration: 900 });
$('view-top').onclick = () => map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
$('sel-close').onclick = () => select(null);
$('sel-follow').onclick = () => setFollow(!state.follow);
$('sel-fly').onclick = flyToSelected;
$('collapse').onclick = () => { $('panel').classList.add('hidden'); $('expand').hidden = false; updatePadding(); };
$('expand').onclick = () => { $('panel').classList.remove('hidden'); $('expand').hidden = true; updatePadding(); };
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

// Type list + model manifest first (small), so the first feed already resolves models.
loadModelRegistry().finally(() => setAirport((location.hash.slice(1) || 'EGLL').slice(0, 4)));
