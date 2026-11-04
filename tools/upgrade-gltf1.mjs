// Upgrades glTF 1.0 binaries (Flightradar24 repo) to glTF 2.0 GLB using Cesium's gltf-pipeline.
//   node tools/upgrade-gltf1.mjs <inDir> <outDir>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import gltfPipeline from 'gltf-pipeline';
const [inDir, outDir] = process.argv.slice(2);
for (const f of (await readdir(inDir)).filter((n) => n.endsWith('.glb'))) {
  try {
    const { gltf } = await gltfPipeline.glbToGltf(await readFile(join(inDir, f)));   // upgrades 1.0 → 2.0
    const { glb } = await gltfPipeline.gltfToGlb(gltf);
    await writeFile(join(outDir, f), glb);
    console.log(`ok   ${f} → ${(glb.length / 1024) | 0}KB`);
  } catch (e) { console.log(`FAIL ${f}: ${e.message}`); }
}
