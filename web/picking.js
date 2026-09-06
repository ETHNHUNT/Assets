import * as THREE from 'three';

/**
 * Which tile is under the pointer.
 *
 * three's InstancedMesh.raycast intersects all 2,936 instances — 9.3 ms per pointer
 * move, over half a 60 fps frame, spent exactly while someone is interacting. A BVH
 * does not help, because the geometry is a single quad and the cost is the instance
 * loop itself, not the triangles. So: reject on perpendicular distance from the ray
 * first, which is one dot product per tile and no matrix work, then do the real
 * intersection only on what survives.
 *
 * This owns no buffers. It reads `posCur`/`quatCur` and asks the caller how big a
 * tile is drawn, because the answer depends on the hover and filter easing that
 * web/highlight.js owns — a tile grows while focused, and picking has to agree with
 * what is on screen rather than with a nominal size.
 *
 * Reading posCur is only correct once a morph has settled. Mid-flight it holds the
 * start of the wave, not where tiles are drawn, so the caller is expected to skip
 * picking until then; app.js gates on `morphCtl.value < 1` for exactly this reason.
 */
export class Picker {
  constructor() {
    this.ray = new THREE.Raycaster();
    this._ro = new THREE.Vector3();
    this._rd = new THREE.Vector3();
    this._inv = new THREE.Matrix4();
    this._lo = new THREE.Vector3();
    this._ld = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._cand = [];
  }

  /**
   * The world ray for a pointer position. Exposed because the physics mode wants the
   * same ray to find where a click landed on the ground plane, and building a second
   * raycaster to answer the same question would be the kind of duplication that
   * quietly drifts.
   */
  rayAt(ndc, camera) {
    this.ray.setFromCamera(ndc, camera);
    return this.ray;
  }

  /**
   * @param ndc      pointer in normalised device coordinates
   * @param camera
   * @param n        tile count
   * @param posCur   3 per tile, current positions
   * @param quatCur  4 per tile, current orientations
   * @param active   1 where a tile passes the filters, 0 where it does not
   * @param halfSize (i) => drawn half-extent of tile i
   * @returns the tile index, or -1
   */
  pick(ndc, camera, { n, posCur, quatCur, active, halfSize }) {
    const { _ro, _rd, _inv, _lo, _ld, _m, _p, _q, _s, _cand } = this;
    this.ray.setFromCamera(ndc, camera);
    _ro.copy(this.ray.ray.origin);
    _rd.copy(this.ray.ray.direction);
    _cand.length = 0;

    const MAX_PERP2 = 0.92 * 0.92;         // half-diagonal of a focused tile, squared
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const a = i * 3;
      const dx = posCur[a] - _ro.x, dy = posCur[a + 1] - _ro.y, dz = posCur[a + 2] - _ro.z;
      const t = dx * _rd.x + dy * _rd.y + dz * _rd.z;
      if (t <= 0) continue;                                     // behind the camera
      if (dx * dx + dy * dy + dz * dz - t * t > MAX_PERP2) continue;
      _cand.push(i, t);
    }
    if (!_cand.length) return -1;

    // nearest first, so the first exact hit wins
    const order = [];
    for (let k = 0; k < _cand.length; k += 2) order.push(k);
    order.sort((p, q) => _cand[p + 1] - _cand[q + 1]);

    for (const k of order) {
      const i = _cand[k];
      _p.set(posCur[i * 3], posCur[i * 3 + 1], posCur[i * 3 + 2]);
      _q.set(quatCur[i * 4], quatCur[i * 4 + 1], quatCur[i * 4 + 2], quatCur[i * 4 + 3]);
      _inv.copy(_m.compose(_p, _q, _s)).invert();
      _lo.copy(_ro).applyMatrix4(_inv);
      _ld.copy(_rd).transformDirection(_inv);
      if (Math.abs(_ld.z) < 1e-6) continue;                     // ray parallel to the quad
      const t = -_lo.z / _ld.z;
      if (t < 0) continue;
      const h = halfSize(i);
      if (Math.abs(_lo.x + _ld.x * t) <= h && Math.abs(_lo.y + _ld.y * t) <= h) return i;
    }
    return -1;
  }
}
