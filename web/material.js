import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, texture, mix, smoothstep,
  step as tslStep, positionLocal, normalize, mrt, frontFacing,
} from 'three/tsl';

/**
 * The shader every tile is drawn with, as a TSL node graph.
 *
 * It is one function because it is one graph — nothing outside reads its internals,
 * and splitting it would mean passing nodes between helpers for no gain. What it is
 * worth having in its own file is the company it keeps: this is the only place that
 * decides what a tile looks like, and it used to sit between the code that uploads
 * GPU buffers and the code that wires the DOM.
 *
 * Three things happen here that are easy to mistake for someone else's job:
 *
 *   - placement. positionNode does the morph, so a tile's drawn position is the
 *     interpolation of aFromPD and aToPos, not instanceMatrix, which stays identity.
 *     The CPU animates one uniform; the GPU moves 2,936 tiles.
 *   - the LOD cross-fade, which reads aToPos.w — a lane the detail cache owns while
 *     the morph owns the xyz beside it.
 *   - what a tile contributes to bloom, via mrtNode.
 *
 * @param atlas   the base atlas texture
 * @param perRow  cells per row in that atlas
 * @param detail  DetailCache or null; when absent the full-res path is compiled out
 * @param uMorph  0 at A, 1 at B — the single value a whole re-arrangement rides on
 */
export function tileMaterial({ atlas, perRow, detail, uMorph }) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });

  const meta = attribute('aMeta', 'vec4');
  const dim = meta.y, foc = meta.z;
  const toPD = attribute('aToPos', 'vec4');   // xyz = to-position, w = detail cross-fade

  // An integer index reaches the fragment stage as an interpolated float, and
  // fp32 can land it a hair either side of a whole number — floor()/mod() then
  // resolve neighbouring cells for the quad's two triangles, splitting the tile
  // along its diagonal. Snapping to the nearest integer first makes it exact.
  const snap = (v) => v.add(float(0.5)).floor();

  // flipY is off on both textures, so row 0 is the top of the image.
  // Backfaces (viewed from inside the sphere) flip U so thumbnails remain readable rather than mirrored.
  const u = frontFacing.select(uv().x, uv().x.oneMinus());
  const cellLocal = vec2(u, uv().y.oneMinus());


  const per = float(perRow);
  const cell = snap(meta.x);
  const auv = vec2(cell.mod(per), cell.div(per).floor()).add(cellLocal).div(per);

  let base = texture(atlas, auv).rgb;

  if (detail) {
    // Both textures are sampled and mixed rather than branched: a per-instance
    // branch diverges across a wavefront for no saving on two texture reads.
    const dper = float(detail.perRow);
    const det = meta.w;
    const dsnap = snap(det);
    const duv = vec2(dsnap.mod(dper), dsnap.div(dper).floor()).add(cellLocal).div(dper);
    // cross-fade rather than switch, so sharpening is felt instead of seen
    base = mix(base, texture(detail.texture, duv).rgb, tslStep(float(0), det).mul(toPD.w));
  }
  const lum = base.r.mul(0.299).add(base.g.mul(0.587)).add(base.b.mul(0.114));
  const ghost = vec3(lum.mul(0.30), lum.mul(0.33), lum.mul(0.46));   // cold, receded
  const lit = mix(ghost, base, dim).add(vec3(0.15, 0.17, 0.28).mul(foc));
  mat.colorNode = vec4(lit, 1.0);

  // What this tile contributes to the bloom target: the focused record glows,
  // and each thumbnail's own highlights lift a little so the wall reads as lit
  // rather than as a texture sheet. Filtered-out tiles contribute nothing.
  const highlight = smoothstep(float(0.62), float(1.0), lum).mul(0.42);
  const glow = foc.mul(0.85).add(highlight).mul(dim);
  mat.mrtNode = mrt({ emissive: vec4(lit.mul(glow), 1.0) });

  // rounded corners, so the wall reads as tiles rather than a texture sheet
  const R = float(0.07);
  const d = uv().sub(0.5).abs().sub(vec2(float(0.5).sub(R), float(0.5).sub(R)))
    .max(vec2(0, 0)).length().sub(R);
  mat.opacityNode = float(1).sub(smoothstep(float(-0.006), float(0.006), d));
  mat.alphaTest = 0.5;

  // filtered-out tiles shrink back; the hovered one lifts toward the viewer
  const s = float(1).add(foc.mul(0.30)).mul(mix(float(0.40), float(1.0), dim));

  // Per-instance local time: each tile starts at its own delay and still lands
  // on 1, so the arrangement resolves as a wave instead of a switch.
  const fromPD = attribute('aFromPD', 'vec4');
  const delay = fromPD.w;
  const span = float(1).sub(delay).max(float(0.001));
  const tl = uMorph.sub(delay).div(span).clamp(0, 1);
  const e = tl.mul(tl).mul(float(3).sub(tl.mul(2)));      // smoothstep: settles, no overshoot

  const pos = mix(fromPD.xyz, toPD.xyz, e);
  // nlerp rather than slerp — indistinguishable at these angles and far cheaper
  const q = normalize(mix(attribute('aQuatA', 'vec4'), attribute('aQuatB', 'vec4'), e));

  // rotate the scaled quad by q:  v + 2*w*(qv x v) + 2*(qv x (qv x v))
  const v = positionLocal.mul(vec3(s, s, float(1)));
  const t2 = q.xyz.cross(v).mul(2);
  mat.positionNode = v.add(t2.mul(q.w)).add(q.xyz.cross(t2)).add(pos);
  return mat;
}
