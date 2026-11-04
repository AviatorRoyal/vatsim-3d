// Aircraft model registry.
//   ICAO type (e.g. "B38M") ──► specific model, if we have one      (models/manifest.json "types")
//                           └─► else its Doc 8643 class's generic model ("classes")
//   unknown / no flight plan ─► the "unknown" class model
//
// Models are .glb files normalised by tools/normalize-models.mjs: +Y nose, +Z up, metres.
// deck.gl's ScenegraphLayer downloads a model the first time the app asks for it (zoomed in,
// aircraft of that type in view). Until it has loaded, the app draws its low-poly mesh instead.

const TYPES_URL = 'data/aircraft-types.json';
const MANIFEST_URL = 'models/manifest.json';

let typeDb = null;     // ICAO -> [name, desc, wtc, class]
let manifest = null;   // { models, classes, types }
const cache = new Map();  // ICAO type -> resolved info

export const CLASS_LABELS = {
  airliner_narrow: 'Narrow-body airliner', airliner_wide: 'Wide-body airliner', airliner_quad: 'Four-engine heavy',
  regional_jet: 'Regional jet', bizjet: 'Business jet', turboprop: 'Turboprop', turboprop_light: 'Light twin turboprop',
  ga_turboprop: 'Single turboprop', ga_single: 'Light single', ga_twin: 'Light twin', glider: 'Glider',
  helicopter: 'Helicopter', helicopter_tandem: 'Tandem-rotor helicopter', gyrocopter: 'Gyrocopter', tiltrotor: 'Tilt-rotor',
  fighter: 'Military jet', balloon: 'Balloon', airship: 'Airship', drone: 'Drone', ground: 'Ground vehicle', unknown: 'Unknown type',
};

export async function loadModelRegistry() {
  const [t, m] = await Promise.all([
    fetch(TYPES_URL).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    fetch(MANIFEST_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  typeDb = t;
  manifest = m;
  cache.clear();
  return !!manifest;
}

/**
 * Resolve the model for an ICAO type designator.
 * Returns { modelId, url, lengthM, specific, cls, typeName, modelName } (modelId null if no registry).
 */
export function resolveModel(icaoType) {
  const key = (icaoType || '').toUpperCase();
  if (cache.has(key)) return cache.get(key);
  const entry = typeDb?.[key];
  const cls = entry?.[3] || 'unknown';
  let modelId = manifest?.types[key] || null;
  const specific = !!modelId;
  if (!modelId) modelId = manifest?.classes[cls] || manifest?.classes.unknown || null;
  const m = modelId ? manifest.models[modelId] : null;
  const info = {
    modelId: m ? modelId : null,
    url: m ? `models/${m.file}` : null,
    // Largest dimension, used to keep models visible when zoomed out (a balloon is tall, not long).
    lengthM: m ? Math.max(m.lengthM, m.spanM, m.heightM) : 35,
    specific,
    cls,
    typeName: entry?.[0] || '',
    modelName: m?.name || '',
  };
  cache.set(key, info);
  return info;
}

