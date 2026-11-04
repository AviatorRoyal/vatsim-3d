// Prints bounds (metres, glTF axes), triangle count and texture info for GLB files.
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const b = getBounds(scene);
  const ext = b.max.map((v, i) => (v - b.min[i]).toFixed(1));
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
    tris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
  }
  const tex = root.listTextures().map((t) => `${t.getMimeType()}:${(t.getImage()?.byteLength / 1024) | 0}KB`);
  console.log(`${f.split(/[\/]/).pop().padEnd(14)} ext x/y/z ${ext.join(' / ').padEnd(22)} min ${b.min.map((v) => v.toFixed(1)).join(',').padEnd(18)} tris ${String(tris | 0).padStart(7)} mats ${root.listMaterials().length} tex ${tex.length} ${tex.slice(0, 3).join(' ')} anim ${root.listAnimations().length}`);
}
