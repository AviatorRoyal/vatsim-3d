// Builds a low-poly aircraft mesh for deck.gl's SimpleMeshLayer.
// Units: 1 = full length of the aircraft. +Y is the nose, +X the right wing, +Z up.
// Each part is a convex prism, flat shaded with outward-facing normals.

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/**
 * Extrude a convex polygon (`base`, 3D points, in order) along vector `off`.
 * Pushes triangles into `pos`/`nrm`, oriented away from the prism's centroid.
 */
function prism(pos, nrm, base, off) {
  const top = base.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
  const all = base.concat(top);
  const c = all.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / all.length);

  const tri = (a, b, d) => {
    let n = norm(cross(sub(b, a), sub(d, a)));
    const mid = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
    if (dot(n, sub(mid, c)) < 0) { [b, d] = [d, b]; n = [-n[0], -n[1], -n[2]]; }
    pos.push(...a, ...b, ...d);
    nrm.push(...n, ...n, ...n);
  };

  const n = base.length;
  for (let i = 1; i < n - 1; i++) {
    tri(base[0], base[i], base[i + 1]);
    tri(top[0], top[i], top[i + 1]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(base[i], base[j], top[j]);
    tri(base[i], top[j], top[i]);
  }
}

export function buildAircraftMesh() {
  const pos = [];
  const nrm = [];
  const fw = 0.055; // fuselage half-width
  const fh = 0.055; // fuselage half-height

  // Fuselage: octagonal cross-section extruded nose-to-tail, plus a tapered nose and tail cone.
  const ring = (y, s) => {
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push([Math.cos(a) * fw * s, y, Math.sin(a) * fh * s]);
    }
    return pts;
  };
  prism(pos, nrm, ring(-0.32, 1), [0, 0.62, 0]);       // cabin
  frustum(pos, nrm, ring(0.30, 1), ring(0.5, 0.15));    // nose
  frustum(pos, nrm, ring(-0.32, 1), ring(-0.5, 0.35));  // tail cone

  // Swept main wings (one prism per side keeps each convex).
  const wz = -0.02;
  const wt = 0.018;
  prism(pos, nrm, [[0.03, 0.10, wz], [0.48, -0.12, wz], [0.48, -0.19, wz], [0.03, -0.10, wz]], [0, 0, wt]);
  prism(pos, nrm, [[-0.03, 0.10, wz], [-0.03, -0.10, wz], [-0.48, -0.19, wz], [-0.48, -0.12, wz]], [0, 0, wt]);

  // Horizontal stabiliser.
  const hz = 0.01;
  prism(pos, nrm, [[0.02, -0.36, hz], [0.19, -0.45, hz], [0.19, -0.49, hz], [0.02, -0.46, hz]], [0, 0, 0.012]);
  prism(pos, nrm, [[-0.02, -0.36, hz], [-0.02, -0.46, hz], [-0.19, -0.49, hz], [-0.19, -0.45, hz]], [0, 0, 0.012]);

  // Vertical fin.
  prism(pos, nrm, [[-0.008, -0.30, fh * 0.6], [-0.008, -0.42, 0.22], [-0.008, -0.49, 0.22], [-0.008, -0.48, fh * 0.6]], [0.016, 0, 0]);

  const positions = new Float32Array(pos);
  const normals = new Float32Array(nrm);
  const texCoords = new Float32Array((positions.length / 3) * 2);
  return {
    attributes: {
      POSITION: { value: positions, size: 3 },
      NORMAL: { value: normals, size: 3 },
      TEXCOORD_0: { value: texCoords, size: 2 },
    },
  };
}

/** Closed frustum between two rings with the same vertex count. */
function frustum(pos, nrm, a, b) {
  const n = a.length;
  const all = a.concat(b);
  const c = all.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / all.length);
  const tri = (p, q, r) => {
    let nn = norm(cross(sub(q, p), sub(r, p)));
    const mid = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
    if (dot(nn, sub(mid, c)) < 0) { [q, r] = [r, q]; nn = [-nn[0], -nn[1], -nn[2]]; }
    pos.push(...p, ...q, ...r);
    nrm.push(...nn, ...nn, ...nn);
  };
  for (let i = 1; i < n - 1; i++) { tri(a[0], a[i], a[i + 1]); tri(b[0], b[i], b[i + 1]); }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(a[i], a[j], b[j]);
    tri(a[i], b[j], b[i]);
  }
}
