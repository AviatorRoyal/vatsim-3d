// Data sources: VATSIM Data API v3, VATSpy (airports + FIR callsign prefixes),
// OurAirports (runway geometry). All three send permissive CORS headers.

export const FEED_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const VATSPY_URL = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/VATSpy.dat';
const RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';

// Used if VATSpy can't be reached, so the default view still works.
const FALLBACK_AIRPORTS = {
  EGLL: { icao: 'EGLL', name: 'London Heathrow', lat: 51.4775, lon: -0.461389, iata: 'LHR', fir: 'EGTT' },
};

let vatspyPromise = null;
let runwaysPromise = null;

function loadVatspy() {
  if (!vatspyPromise) {
    vatspyPromise = fetch(VATSPY_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`VATSpy HTTP ${r.status}`))))
      .then(parseVatspy)
      .catch((err) => {
        console.warn('VATSpy unavailable, using fallback airport list', err);
        return { airports: { ...FALLBACK_AIRPORTS }, firPrefixes: { EGTT: new Set(['LON', 'LTC']) } };
      });
  }
  return vatspyPromise;
}

function parseVatspy(text) {
  const airports = {};
  const firPrefixes = {}; // FIR ICAO (e.g. EGTT) -> Set of callsign prefixes (LON, LTC, ...)
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    const f = line.split('|');
    if (section === '[Airports]' && f.length >= 6) {
      const icao = f[0].toUpperCase();
      if (!airports[icao]) airports[icao] = { icao, name: f[1], lat: +f[2], lon: +f[3], iata: f[4], fir: f[5], pseudo: f[6] === '1' };
    } else if (section === '[FIRs]' && f.length >= 3) {
      const fir = f[0].split('-')[0].toUpperCase();
      const prefix = (f[2] || '').split('_')[0].toUpperCase();
      if (prefix) (firPrefixes[fir] ||= new Set()).add(prefix);
    }
  }
  return { airports, firPrefixes };
}

export async function findAirport(icao) {
  const { airports, firPrefixes } = await loadVatspy();
  const ap = airports[icao.toUpperCase()];
  if (!ap) return null;
  const prefixes = new Set([ap.icao]);
  if (ap.iata) prefixes.add(ap.iata.toUpperCase());
  for (const p of firPrefixes[ap.fir] || []) prefixes.add(p);
  return { ...ap, atcPrefixes: prefixes };
}

// --- Runways ---------------------------------------------------------------

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parses OurAirports runways.csv once into Map<ICAO, [{ le, he, lePos, hePos, widthM, lengthFt, elevFt }]>.
 * Resolves to an empty map if the file can't be fetched (airports then show without runways).
 */
export function loadRunwayIndex() {
  if (!runwaysPromise) {
    runwaysPromise = fetch(RUNWAYS_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`runways HTTP ${r.status}`))))
      .then(parseRunways)
      .catch((err) => { console.warn('Runway data unavailable', err); runwaysPromise = null; return new Map(); });
  }
  return runwaysPromise;
}

function parseRunways(text) {
  const index = new Map();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsv(line);
    // id, airport_ref, airport_ident, length_ft, width_ft, surface, lighted, closed,
    // le_ident, le_lat, le_lon, le_elev, le_hdg, le_disp, he_ident, he_lat, he_lon, he_elev, ...
    if (f[7] === '1') continue;
    const leLat = parseFloat(f[9]), leLon = parseFloat(f[10]);
    const heLat = parseFloat(f[15]), heLon = parseFloat(f[16]);
    if (!(Number.isFinite(leLat) && Number.isFinite(leLon) && Number.isFinite(heLat) && Number.isFinite(heLon))) continue;
    const elevs = [parseFloat(f[11]), parseFloat(f[17])].filter(Number.isFinite);
    const icao = f[2].toUpperCase();
    let list = index.get(icao);
    if (!list) index.set(icao, (list = []));
    list.push({
      le: f[8], he: f[14],
      lePos: [leLon, leLat], hePos: [heLon, heLat],
      widthM: (parseFloat(f[4]) || 150) * 0.3048,
      lengthFt: parseFloat(f[3]) || 0,
      elevFt: elevs.length ? elevs.reduce((a, b) => a + b, 0) / elevs.length : null,
    });
  }
  return index;
}

/** All VATSpy airports (non-pseudo) within `radiusNm` of a point, with their runways attached. */
export async function airportsNear(lat, lon, radiusNm) {
  const [{ airports }, runwayIndex] = await Promise.all([loadVatspy(), loadRunwayIndex()]);
  const out = [];
  const dLat = radiusNm / 60;
  const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  for (const ap of Object.values(airports)) {
    if (ap.pseudo || Math.abs(ap.lat - lat) > dLat || Math.abs(ap.lon - lon) > dLon) continue;
    const distNm = haversineNm(lat, lon, ap.lat, ap.lon);
    if (distNm > radiusNm) continue;
    const runways = runwayIndex.get(ap.icao) || [];
    const elevs = runways.map((r) => r.elevFt).filter((e) => e != null);
    out.push({
      icao: ap.icao, name: ap.name, lat: ap.lat, lon: ap.lon, distNm, runways,
      maxRunwayFt: runways.reduce((m, r) => Math.max(m, r.lengthFt), 0),
      elevFt: elevs.length ? elevs.reduce((a, b) => a + b, 0) / elevs.length : 0,
    });
  }
  return out.sort((a, b) => a.distNm - b.distNm);
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

// --- Live feed -------------------------------------------------------------

export async function fetchFeed() {
  const r = await fetch(FEED_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`VATSIM feed HTTP ${r.status}`);
  return r.json();
}
