// Generates a weather (sounding) balloon GLB procedurally, at real-world scale in metres:
// a slightly translucent latex envelope, an orange parachute, a tether line and a radiosonde box.
// Output is Y-up like any glTF; the normaliser re-orients it with the other models.
//
//   node tools/make-weather-balloon.mjs <out.glb>
import { Document, NodeIO } from '@gltf-transform/core';

const out = process.argv[2] || 'models/raw/gen/weather-balloon.glb';
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('balloon');

function primitive(positions, normals, indices, material) {
  return doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer))
    .setMaterial(material);
}

/** Surface of revolution around Y from a profile [[radius, y], ...] (top to bottom). */
function lathe(profile, segments = 40) {
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    const prev = profile[Math.max(0, i - 1)], next = profile[Math.min(profile.length - 1, i + 1)];
    const dr = next[0] - prev[0], dy = next[1] - prev[1];
    let nr = -dy, ny = dr; // outward normal of the profile curve
    const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      nrm.push(Math.cos(a) * nr, ny, Math.sin(a) * nr);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let s = 0; s < segments; s++) {
      const a = i * row + s, b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos, nrm, idx };
}

function box(cx, cy, cz, sx, sy, sz) {
  const pos = [], nrm = [], idx = [];
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const n of faces) {
    const u = n[0] ? [0, 1, 0] : [1, 0, 0];
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const base = pos.length / 3;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(cx + (n[0] + u[0] * du + v[0] * dv) * sx / 2, cy + (n[1] + u[1] * du + v[1] * dv) * sy / 2, cz + (n[2] + u[2] * du + v[2] * dv) * sz / 2);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx };
}

const mat = (name, rgba, rough = 0.6, blend = false) => {
  const m = doc.createMaterial(name).setBaseColorFactor(rgba).setMetallicFactor(0).setRoughnessFactor(rough).setDoubleSided(true);
  if (blend) m.setAlphaMode('BLEND');
  return m;
};
const latex = mat('latex', [0.95, 0.93, 0.86, 0.92], 0.35, true);
const chute = mat('parachute', [0.98, 0.42, 0.1, 1], 0.7);
const line = mat('line', [0.85, 0.85, 0.85, 1], 0.9);
const sonde = mat('radiosonde', [0.96, 0.96, 0.96, 1], 0.5);
const sondeBand = mat('radiosonde-band', [0.9, 0.2, 0.15, 1], 0.5);

const mesh = doc.createMesh('weather-balloon');
// Envelope: ~2.4 m wide at launch, slightly teardrop with a neck at the bottom. Neck at y = 0.
const R = 1.2, env = [];
for (let i = 0; i <= 24; i++) {
  const t = i / 24, a = Math.PI * t;                       // top (0) → bottom (π)
  const r = Math.sin(a) * R * (1 - 0.18 * t * t);          // narrower towards the neck
  env.push([Math.max(r, 0.06), R * 0.95 * Math.cos(a) + R * 1.05]);
}
env.push([0.05, 0], [0.05, -0.15]);
let g = lathe(env); mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, latex));
// Parachute canopy 4 m below the neck.
g = lathe([[0.02, -3.6], [0.35, -3.65], [0.6, -3.85], [0.72, -4.15], [0.74, -4.3]], 24);
mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, chute));
// Tether: neck → parachute → radiosonde, 20 m in total (thin box segments).
g = box(0, -1.9, 0, 0.03, 3.5, 0.03); mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, line));
g = box(0, -12.2, 0, 0.03, 15.8, 0.03); mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, line));
// Radiosonde: a small polystyrene box with a red band.
g = box(0, -20.25, 0, 0.32, 0.4, 0.22); mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, sonde));
g = box(0, -20.25, 0, 0.33, 0.08, 0.23); mesh.addPrimitive(primitive(g.pos, g.nrm, g.idx, sondeBand));

scene.addChild(doc.createNode('weather-balloon').setMesh(mesh));
await new NodeIO().write(out, doc);
console.log(`wrote ${out}`);
