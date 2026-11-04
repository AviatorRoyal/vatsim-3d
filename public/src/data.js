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
      if (!airports[icao]) airports[icao] = { icao, name: f[1], lat: +f[2], lon: +f[3], iata: f[4], fir: f[5] };
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

/** Returns [{ le, he, lePos:[lon,lat], hePos:[lon,lat], widthM, elevFt }] for an airport. */
export async function loadRunways(icao) {
  if (!runwaysPromise) {
    runwaysPromise = fetch(RUNWAYS_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`runways HTTP ${r.status}`))))
      .catch((err) => { console.warn('Runway data unavailable', err); runwaysPromise = null; return ''; });
  }
  const text = await runwaysPromise;
  const needle = `,"${icao.toUpperCase()}",`;
  const result = [];
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    const f = splitCsv(line);
    // id, airport_ref, airport_ident, length_ft, width_ft, surface, lighted, closed,
    // le_ident, le_lat, le_lon, le_elev, le_hdg, le_disp, he_ident, he_lat, he_lon, he_elev, ...
    if (f[7] === '1') continue;
    const leLat = parseFloat(f[9]), leLon = parseFloat(f[10]);
    const heLat = parseFloat(f[15]), heLon = parseFloat(f[16]);
    if (![leLat, leLon, heLat, heLon].every(Number.isFinite)) continue;
    const elevs = [parseFloat(f[11]), parseFloat(f[17])].filter(Number.isFinite);
    result.push({
      le: f[8], he: f[14],
      lePos: [leLon, leLat], hePos: [heLon, heLat],
      widthM: (parseFloat(f[4]) || 150) * 0.3048,
      elevFt: elevs.length ? elevs.reduce((a, b) => a + b, 0) / elevs.length : null,
    });
  }
  return result;
}

// --- Live feed -------------------------------------------------------------

export async function fetchFeed() {
  const r = await fetch(FEED_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`VATSIM feed HTTP ${r.status}`);
  return r.json();
}
