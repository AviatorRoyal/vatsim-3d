// Builds public/data/aircraft-types.json from the full ICAO Doc 8643 type list
// (as mirrored by wiedehopf/tar1090-db), classifying every designator into a generic class.
//
//   node tools/build-types.mjs
//
// Output: { "<ICAO>": [name, docDescription, wtc, class], ... }  plus a "_classes" summary.
import { writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const SRC = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types2.js';
const OUT = new URL('../public/data/aircraft-types.json', import.meta.url);

// --- Name-based refinements (the Doc 8643 description code can't tell these apart) ----------------

const TANDEM_ROTOR = /CH-47|Chinook|CH-46|Sea Knight|Model 107|Model 114|Model 234|H-21|Yak-24|HC Mk/i;

const FIGHTER = new RegExp([
  String.raw`\bF\/A-\d`, String.raw`\bEF-\d`, 'Boramae', 'Kaan', 'Ching-Kuo', 'Yak-141', 'Yak-38', 'Saeghe', String.raw`MiG \d`, 'Scorpion', 'Red Hawk', String.raw`\bF-\d`, String.raw`\bFA-\d`, 'Eurofighter', 'Typhoon', 'Rafale', 'Gripen',
  String.raw`MiG-\d`, String.raw`Su-(?:7|9|11|15|17|20|22|24|25|27|30|33|34|35|37|47|57|75)\b`, 'Tornado', 'Harrier', 'Mirage', 'Hornet',
  'Raptor', 'Lightning', 'Tomcat', 'Phantom', 'Jaguar', 'Viggen', 'Draken', 'Starfighter', 'Sabre', 'Hunter',
  'Skyhawk', 'Alpha Jet', 'Albatros', 'L-159', 'T-38', 'Talon', 'Goshawk', String.raw`\bHawk\b`, 'Yak-130', 'M-346', 'Master',
  'JF-17', String.raw`\bJ-\d{1,2}\b`, 'Tejas', 'Kfir', 'Etendard', 'Intruder', 'Thunderbolt', 'Nighthawk', 'Super Tucano',
  'Aermacchi MB', 'Strikemaster', 'Jet Provost', 'Gnat', 'Fouga', 'Magister', 'Vampire', 'Venom', 'Meteor', 'Lim-',
  'Kawasaki T-4', 'Hongdu', 'Guizhou JL', 'KAI T-50', 'Golden Eagle', 'Hürjet', 'Hurjet', 'Saab 105', 'Saab 32', 'Saab 35',
  'Galeb', 'Orao', 'Soko', 'Cougar', 'Panther', 'Crusader', 'Corsair II', 'Vigilante', 'Buccaneer', 'Lightning F',
].join('|'), 'i');
// Large military jets that the fighter regex might otherwise catch.
const NOT_FIGHTER = /Stratofortress|Lancer|Spirit|Globemaster|Galaxy|Stratotanker|Extender|Pegasus|Sentry|Starlifter|Hercules|Poseidon|Orion|Atlas|Tristar|Tu-\d|Il-\d|Il-76|Backfire|Blackjack|Vulcan|Victor|Nimrod|Hawker|Gulfstream|Citation|Lear|Learjet|Falcon \d|Mystere|Jetstar|Sabreliner|Hunter.*Hawker|Fokker|AdamJet|Global Flyer|Global Hawk|Stingray|Albatross|Altair|\bU-2\b/i;

const BIZJET = new RegExp([
  'Citation', 'Gulfstream', 'Learjet', 'Lear Jet', String.raw`\bLear\b`, String.raw`Falcon\s?\d|Falcon 2000|Falcon 900|Falcon 7X|Falcon 8X|Falcon 6X|Mystere`, 'Challenger',
  'Global (?:Express|5000|5500|6000|6500|7500|8000)', 'Phenom', 'Legacy', 'Praetor', 'Lineage', 'Hawker', 'HondaJet', 'HA-420', 'PC-24',
  'Vision', 'SF50', 'Eclipse', 'Premier', 'Beechjet', 'Diamant', 'Sabreliner', 'Westwind', 'Astra', 'Galaxy', 'Jetstar',
  'Mustang', 'Corvette', 'HFB-320', 'Hansa', 'BAe-125', 'HS-125', 'DH-125', 'BD-700', 'BD-100', 'CL-600', 'CL-601', 'CL-604', 'CL-605',
  'Stratos', 'SyberJet', 'Nextant', 'Spectre', 'BBJ', 'ACJ', 'Epic', 'D-Jet', 'Grob G-180', 'SpectrumJet', 'Jet Commander',
  'AdamJet', 'Commodore Jet', String.raw`MU-300`, 'Diamond',
].join('|'), 'i');

const REGIONAL_JET = /Regional Jet|CRJ|\bERJ|ERJ-1[3-9]|Embraer E1|EMB-1[3-9]5|E-?1[79]0|E-?195|E-?175|Avro RJ|RJ-?[78]\d|BAe-146|BAe 146|Fokker F-?(28|70|100)|Fokker 70|Fokker 100|Superjet|SSJ|ARJ-?21|Yak-40|Yak-42|Dornier 328|328JET|MRJ|SpaceJet|An-148|An-158|Do-728|VFW-614|BAC-111|One-Eleven|Caravelle|F-28|\b146-\d/i;

const QUAD_JET_NAMES = /747|A-?380|A-?340|An-124|An-225|BAe-146|Avro RJ|Il-86|Il-96|DC-8|707|VC-10|Convair 880|Convair 990|Comet|C-17|KC-135|E-3|E-6|Tu-114|Tu-160|B-52/i;

/** Classify one Doc 8643 entry. `desc` is e.g. "L2J": kind, engine count, engine type. */
export function classify(icao, name, desc, wtc) {
  const kind = desc[0];
  const engines = parseInt(desc[1], 10) || 0;
  const type = desc[2];

  if (icao === 'BALL' || (kind === 'B' && icao !== 'SHIP')) return 'balloon';
  if (icao === 'SHIP') return 'airship';
  if (kind === 'D' || icao === 'DRON' || icao === 'FFLO') return 'drone';
  if (kind === 'V' || kind === 'T' || icao === 'ZZZZ' || kind === '-') return 'ground';
  if (icao === 'PARA' || kind === 'P') return 'glider';
  if (kind === 'H') return TANDEM_ROTOR.test(name) ? 'helicopter_tandem' : 'helicopter';
  if (kind === 'G') return 'gyrocopter';
  if (kind === 'R') return 'tiltrotor';
  if (engines === 0 || type === '-' && kind === 'L') return 'glider';

  if (type === 'J') {
    if (FIGHTER.test(name) && !NOT_FIGHTER.test(name) && engines <= 2 && wtc !== 'H') return 'fighter';
    if (BIZJET.test(name) && wtc !== 'H') return 'bizjet';
    if (wtc === 'H' || wtc === 'J') return engines >= 4 || QUAD_JET_NAMES.test(name) ? 'airliner_quad' : 'airliner_wide';
    if (REGIONAL_JET.test(name)) return 'regional_jet';
    if (wtc === 'L') return 'bizjet';                        // light jets are overwhelmingly business/VLJ
    if (engines === 1) return 'fighter';                     // single-engine medium jets are military
    return 'airliner_narrow';
  }
  if (type === 'T') {
    if (engines === 1) return wtc === 'L' ? 'ga_turboprop' : 'turboprop';
    return wtc === 'L' ? 'turboprop_light' : 'turboprop';
  }
  // Piston, electric, rocket and anything else with wings.
  return engines >= 2 ? 'ga_twin' : 'ga_single';
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${SRC}`);
const buf = Buffer.from(await res.arrayBuffer());
const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
const src = JSON.parse(text);

const out = {};
const counts = {};
for (const [icao, [name, desc, wtc]] of Object.entries(src)) {
  const cls = classify(icao, name || '', desc || '-0-', wtc || '-');
  out[icao] = [name || '', desc || '', wtc || '', cls];
  counts[cls] = (counts[cls] || 0) + 1;
}
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ _source: SRC, _generated: new Date().toISOString(), _classes: counts, ...out }));
console.log(`${Object.keys(out).length} types →`, counts);
