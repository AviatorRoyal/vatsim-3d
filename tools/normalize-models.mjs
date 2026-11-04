// Normalises downloaded glTF/GLB models so the app can treat them all the same way:
//   • +Y = nose, +Z = up, +X = right wing
//   • 1 unit = 1 metre, scaled to the real aircraft length
//   • origin centred under the aircraft (bottom of the model at z = 0)
// and writes public/models/<id>.glb plus public/models/manifest.json.
//
//   node tools/normalize-models.mjs
//
// Inputs: models/sources.json (what each model is, where it came from, its licence, its axes)
//         models/raw/<file>   (the original downloads, kept out of the published site)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

const MAX_TEXTURE = 512; // px; keeps GPU memory low (each 512² texture ≈ 1.3 MB with mipmaps)

const ROOT = new URL('../', import.meta.url);
const sources = JSON.parse(await readFile(new URL('models/sources.json', ROOT), 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await mkdir(new URL('public/models/', ROOT), { recursive: true });

const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quaternion for the rotation whose matrix rows are (right, nose, up) in source space. */
function basisQuat(nose, up) {
  const r = cross(nose, up);
  // Rotation matrix R maps source → target: target = R · source, with rows r, nose, up.
  const m = [r, nose, up];
  const [m00, m01, m02] = m[0], [m10, m11, m12] = m[1], [m20, m21, m22] = m[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

/** Downsize textures larger than MAX_TEXTURE, keeping JPEG/PNG so the viewer needs no extensions. */
async function shrinkTextures(doc) {
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    try {
      const s = sharp(Buffer.from(img));
      const meta = await s.metadata();
      const png = tex.getMimeType() === 'image/png';
      const big = Math.max(meta.width || 0, meta.height || 0) > MAX_TEXTURE;
      if (!big && !png) continue;
      let pipe = s.resize({ width: MAX_TEXTURE, height: MAX_TEXTURE, fit: 'inside', withoutEnlargement: true });
      // Opaque PNGs are re-encoded as JPEG (much smaller); PNGs with alpha stay PNG.
      const out = png && meta.hasAlpha
        ? await pipe.png({ compressionLevel: 9, palette: true }).toBuffer()
        : await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      if (out.byteLength < img.byteLength) {
        tex.setImage(new Uint8Array(out));
        tex.setMimeType(png && meta.hasAlpha ? 'image/png' : 'image/jpeg');
        tex.setURI(tex.getURI().replace(/\.\w+$/, png && meta.hasAlpha ? '.png' : '.jpg'));
      }
    } catch (e) { console.warn(`  texture ${tex.getName() || tex.getURI()} left as-is: ${e.message}`); }
  }
}

const manifest = { models: {}, classes: sources.classes, types: {} };

for (const m of sources.models) {
  const doc = await io.read(new URL(`models/raw/${m.file}`, ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];

  // Wrap everything in one root node that re-orients, scales and recentres the model.
  const root = doc.createNode(`${m.id}_root`);
  for (const child of scene.listChildren()) { scene.removeChild(child); root.addChild(child); }
  scene.addChild(root);

  const q = basisQuat(AXES[m.nose], AXES[m.up || '+y']);
  root.setRotation(q);
  let b = getBounds(scene);
  const extent = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  // Most sources are already metric; `lengthM` rescales the ones that aren't (or are slightly off).
  const s = m.lengthM ? m.lengthM / extent[1] : 1;
  root.setScale([s, s, s]);
  b = getBounds(scene);
  root.setTranslation([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  b = getBounds(scene);

  // Drop animations (rotor spin etc. would need per-instance timing) and tidy up.
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  await doc.transform(dedup(), weld(), prune());
  await shrinkTextures(doc);

  const outFile = `${m.id}.glb`;
  await io.write(new URL(`public/models/${outFile}`, ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'), doc);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => +v.toFixed(2));
  manifest.models[m.id] = {
    file: outFile, lengthM: size[1], spanM: size[0], heightM: size[2], name: m.name,
    title: m.title, author: m.author, licence: m.licence, source: m.source,
  };
  for (const t of m.types || []) manifest.types[t] = m.id;
  console.log(`${m.id.padEnd(14)} ${m.file.padEnd(28)} native ${extent.map((v) => v.toFixed(2)).join('×')} → ${size.join('×')} m`);
}

await writeFile(new URL('public/models/manifest.json', ROOT), JSON.stringify(manifest, null, 1));
console.log(`wrote ${Object.keys(manifest.models).length} models`);
