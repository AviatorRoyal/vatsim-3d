// Minimal AC3D (.ac, FlightGear's model format) → glTF 2.0 GLB converter.
//
//   node tools/ac3d-to-glb.mjs <in.ac> <out.glb> [--exclude <regex>] [--flat-color r,g,b] [--texdir <dir>]
//
// • Bakes the object hierarchy (loc/rot) into one mesh, one primitive per material+texture.
// • --exclude drops objects (and their children) whose name matches, e.g. cockpit interiors.
// • Textures are used when a matching .png exists in --texdir; anything else (e.g. SGI .rgb)
//   falls back to the AC3D material colour, or to --flat-color when given.
import { readFile, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';

const args = process.argv.slice(2);
const [inFile, outFile] = args;
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const exclude = opt('--exclude') ? new RegExp(opt('--exclude'), 'i') : null;
const flatColor = opt('--flat-color') ? opt('--flat-color').split(',').map(Number) : null;
const texDir = opt('--texdir') || dirname(inFile);

const text = await readFile(inFile, 'latin1');
let pos = 0;
const lines = text.split(/\r?\n/);
const next = () => lines[pos++];

if (!next().startsWith('AC3D')) throw new Error('not an AC3D file');

// --- Materials -----------------------------------------------------------------------------------
const materials = [];
while (lines[pos].startsWith('MATERIAL')) {
  const l = next();
  const num = (key, n) => { const m = l.match(new RegExp(`${key}\\s+([-\\d.e]+)${'\\s+([-\\d.e]+)'.repeat(n - 1)}`)); return m ? m.slice(1).map(Number) : null; };
  materials.push({ name: (l.match(/"([^"]*)"/) || [])[1] || 'mat', rgb: num('rgb', 3), shi: num('shi', 1)?.[0] ?? 0, trans: num('trans', 1)?.[0] ?? 0, emis: num('emis', 3) });
}

// --- Objects -------------------------------------------------------------------------------------
const groups = new Map(); // key -> { mat, tex, pos:[], nrm:[], uv:[], twoSided }
let kept = 0, dropped = 0;

function mulRot(r, v) { return [v[0] * r[0] + v[1] * r[3] + v[2] * r[6], v[0] * r[1] + v[1] * r[4] + v[2] * r[7], v[0] * r[2] + v[1] * r[5] + v[2] * r[8]]; }

function readObject(parentRot, parentLoc, skip) {
  const header = next(); // OBJECT <type>
  if (!header?.startsWith('OBJECT')) throw new Error(`expected OBJECT at line ${pos}: ${header}`);
  const o = { name: '', rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], loc: [0, 0, 0], texture: null, texrep: [1, 1], texoff: [0, 0], verts: [], surfs: [] };
  for (;;) {
    const l = next();
    if (l === undefined) return;
    const [k, ...rest] = l.trim().split(/\s+/);
    if (k === 'name') o.name = (l.match(/"([^"]*)"/) || [])[1] || '';
    else if (k === 'data') { let n = +rest[0]; while (n > 0) { const d = next(); n -= d.length + 1; } }
    else if (k === 'texture') o.texture = (l.match(/"([^"]*)"/) || [])[1] || null;
    else if (k === 'texrep') o.texrep = rest.map(Number);
    else if (k === 'texoff') o.texoff = rest.map(Number);
    else if (k === 'rot') o.rot = rest.map(Number);
    else if (k === 'loc') o.loc = rest.map(Number);
    else if (k === 'numvert') { const n = +rest[0]; for (let i = 0; i < n; i++) o.verts.push(next().trim().split(/\s+/).map(Number)); }
    else if (k === 'numsurf') {
      const n = +rest[0];
      for (let i = 0; i < n; i++) {
        const flags = parseInt(next().trim().split(/\s+/)[1], 16);
        let mat = 0, refs = [];
        for (;;) {
          const s = next().trim().split(/\s+/);
          if (s[0] === 'mat') mat = +s[1];
          else if (s[0] === 'refs') { for (let j = 0; j < +s[1]; j++) { const r = next().trim().split(/\s+/).map(Number); refs.push(r); } break; }
        }
        o.surfs.push({ flags, mat, refs });
      }
    } else if (k === 'kids') {
      // World transform of this object, then emit its geometry, then recurse.
      const rot = o.rot; // AC3D rotations are applied before the parent's transform.
      const worldLoc = [parentLoc[0] + mulRot(parentRot, o.loc)[0], parentLoc[1] + mulRot(parentRot, o.loc)[1], parentLoc[2] + mulRot(parentRot, o.loc)[2]];
      const worldRot = composeRot(parentRot, rot);
      const drop = skip || (exclude && exclude.test(o.name));
      if (!drop && o.surfs.length) { emit(o, worldRot, worldLoc); kept++; } else if (o.surfs.length) dropped++;
      const kids = +rest[0];
      for (let i = 0; i < kids; i++) readObject(worldRot, worldLoc, drop);
      return;
    }
  }
}

// rows-as-vectors convention: v' = v · R ; composing child R_c under parent R_p gives R_c · R_p.
function composeRot(p, c) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = c[i * 3] * p[j] + c[i * 3 + 1] * p[3 + j] + c[i * 3 + 2] * p[6 + j];
  return r;
}

function emit(o, rot, loc) {
  const world = o.verts.map((v) => { const r = mulRot(rot, v); return [r[0] + loc[0], r[1] + loc[1], r[2] + loc[2]]; });
  for (const s of o.surfs) {
    const type = s.flags & 0x0f;
    if (type === 1 || type === 2 || s.refs.length < 3) continue; // lines
    const key = `${s.mat}|${o.texture || ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat: s.mat, tex: o.texture, pos: [], nrm: [], uv: [], twoSided: false }));
    if (s.flags & 0x20) g.twoSided = true;
    const tris = [];
    if (type === 5) for (let i = 2; i < s.refs.length; i++) tris.push(i % 2 ? [s.refs[i - 1], s.refs[i - 2], s.refs[i]] : [s.refs[i - 2], s.refs[i - 1], s.refs[i]]);
    else for (let i = 1; i < s.refs.length - 1; i++) tris.push([s.refs[0], s.refs[i], s.refs[i + 1]]);
    for (const t of tris) {
      const [a, b, c] = t.map((r) => world[r[0]]);
      if (!a || !b || !c) continue;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n);
      if (len < 1e-12) continue;
      n = n.map((x) => x / len);
      for (const r of t) {
        const p = world[r[0]];
        g.pos.push(p[0], p[1], p[2]);
        g.nrm.push(...n);
        // AC3D's v runs bottom-up, glTF's top-down.
        g.uv.push(r[1] * o.texrep[0] + o.texoff[0], 1 - (r[2] * o.texrep[1] + o.texoff[1]));
      }
    }
  }
}

while (pos < lines.length && lines[pos].startsWith('OBJECT')) readObject([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], false);

// --- glTF ----------------------------------------------------------------------------------------
const doc = new Document();
const buffer = doc.createBuffer();
const mesh = doc.createMesh(basename(inFile, '.ac'));
const texCache = new Map();
async function loadTex(name) {
  if (!name) return null;
  if (texCache.has(name)) return texCache.get(name);
  const file = join(texDir, basename(name));
  let tex = null;
  if (/\.png$/i.test(file)) {
    try { await access(file); tex = doc.createTexture(basename(name)).setImage(await readFile(file)).setMimeType('image/png'); } catch { /* missing */ }
  }
  texCache.set(name, tex);
  return tex;
}

for (const g of groups.values()) {
  if (!g.pos.length) continue;
  const m = materials[g.mat] || { name: 'default', rgb: [0.8, 0.8, 0.8], trans: 0, shi: 0 };
  const tex = await loadTex(g.tex);
  const rgb = !tex && flatColor && m.trans < 0.3 ? flatColor : m.rgb || [0.8, 0.8, 0.8];
  const alpha = 1 - Math.min(0.9, m.trans || 0);
  const mat = doc.createMaterial(m.name)
    .setBaseColorFactor([rgb[0], rgb[1], rgb[2], alpha])
    .setMetallicFactor(0)
    .setRoughnessFactor(Math.max(0.25, 1 - (m.shi || 0) / 128))
    .setDoubleSided(true);
  if (alpha < 1) mat.setAlphaMode('BLEND');
  if (tex) mat.setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.nrm)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buffer))
    .setMaterial(mat);
  mesh.addPrimitive(prim);
}
const node = doc.createNode(basename(inFile, '.ac')).setMesh(mesh);
doc.createScene('scene').addChild(node);
await doc.transform(dedup(), weld(), prune());
await new NodeIO().write(outFile, doc);
const tris = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0);
console.log(`${basename(inFile)}: kept ${kept} objects, dropped ${dropped}; ${mesh.listPrimitives().length} primitives, ${tris | 0} tris → ${outFile}`);
