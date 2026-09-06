import * as THREE from 'three';
import { animate } from 'animejs';

/**
 * The layout wave.
 *
 * OWNERSHIP, and it is narrower than it looks. This owns four things and parts of
 * two more:
 *
 *   posCur, posTo, quatCur, quatTo   entirely
 *   aFromPD  .xyz start position  .w stagger delay      entirely
 *   aToPos   .xyz end position                          xyz ONLY
 *   aQuatA, aQuatB                                      entirely
 *
 * `aToPos.w` is the detail cache's cross-fade and `aMeta` is shared between the
 * cache and the hover easing, so neither belongs here. Every write below is
 * channel-scoped for that reason: a `.set()` over a whole attribute array would be
 * shorter and would silently blank the LOD fade mid-flight. That is the bug this
 * module exists to make hard, so if you add a writer, write channels.
 *
 * The interpolation itself is not here at all — it is in the shader, which reads
 * A and B and eases between them by a single uniform with a per-tile delay. So a
 * re-arrangement of 2,936 tiles costs one animated number per frame, not 2,936
 * transforms. Measured: a full re-layout is ~0.2-0.6 ms, and almost all of that is
 * computing the targets, not moving them.
 */
export class MorphController {
  /**
   * @param n        tile count
   * @param attrs    { aFromPD, aToPos, aQuatA, aQuatB } InstancedBufferAttributes
   * @param uMorph   the shader uniform this drives, 0 at A and 1 at B
   * @param stagger  fraction of the timeline given over to the wave
   */
  constructor({ n, attrs, uMorph, stagger = 0.34 }) {
    this.n = n;
    this.attrs = attrs;
    this.uMorph = uMorph;
    this.stagger = stagger;

    this.posCur = new Float32Array(n * 3);
    this.posTo = new Float32Array(n * 3);
    this.quatCur = new Float32Array(n * 4);
    this.quatTo = new Float32Array(n * 4);

    this.value = 1;                 // 1 = settled
    this.anim = null;
    this.duration = 1.1;

    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  get settled() { return this.value >= 1 && !this.anim; }

  /** Where tile `i` is heading, and how it should be oriented when it lands. */
  setTarget(i, x, y, z, q) {
    const a = i * 3, b = i * 4;
    this.posTo[a] = x; this.posTo[a + 1] = y; this.posTo[a + 2] = z;
    this.quatTo[b] = q.x; this.quatTo[b + 1] = q.y;
    this.quatTo[b + 2] = q.z; this.quatTo[b + 3] = q.w;
  }

  /**
   * Push current -> target into the A/B buffers. The delay is what makes it a wave:
   * the tile with furthest to go leaves first, so the whole set still lands together.
   */
  upload(stagger = true) {
    const { n, posCur, posTo, quatCur, quatTo } = this;
    const { aFromPD, aToPos, aQuatA, aQuatB } = this.attrs;

    let maxD = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 3;
      const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxD) maxD = d;
    }
    maxD = Math.sqrt(maxD) || 1;

    for (let i = 0; i < n; i++) {
      const a = i * 3, b = i * 4;
      aFromPD.array[b] = posCur[a];
      aFromPD.array[b + 1] = posCur[a + 1];
      aFromPD.array[b + 2] = posCur[a + 2];
      // xyz only — b+3 is the detail cross-fade and is not ours
      aToPos.array[b] = posTo[a];
      aToPos.array[b + 1] = posTo[a + 1];
      aToPos.array[b + 2] = posTo[a + 2];
      for (let k = 0; k < 4; k++) {
        aQuatA.array[b + k] = quatCur[b + k];
        aQuatB.array[b + k] = quatTo[b + k];
      }
      let delay = 0;
      if (stagger) {
        const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
        delay = (1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / maxD) * this.stagger;
      }
      aFromPD.array[b + 3] = delay;
    }
    this._flush();
  }

  /**
   * How long the wave should take, from how far it has to travel. Sampled every
   * seventh tile — an exact mean is not worth 2,936 square roots for a duration
   * that is then clamped to a 0.9 s window anyway.
   */
  pickDuration(active, reduced) {
    if (reduced) return 0.001;
    const { n, posCur, posTo } = this;
    let sum = 0, count = 0;
    for (let i = 0; i < n; i += 7) {
      if (!active[i]) continue;
      const a = i * 3;
      const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz); count++;
    }
    const mean = count ? sum / count : 0;
    return Math.min(1.8, Math.max(0.9, 0.75 + mean * 0.012));
  }

  /**
   * Run the wave.
   *
   * The master clock stays linear and the shader eases each tile inside its own
   * stagger window — easing here as well would compress the wave and read sluggish.
   */
  start(duration = this.duration) {
    if (this.anim) this.anim.pause();
    this.duration = duration;
    const box = { t: 0 };
    this.value = 0;
    this.uMorph.value = 0;
    this.anim = animate(box, {
      t: 1,
      duration: duration * 1000,
      ease: 'linear',
      onUpdate: () => { this.value = box.t; this.uMorph.value = box.t; },
      onComplete: () => {
        this.value = 1;
        this.uMorph.value = 1;
        this.posCur.set(this.posTo);
        this.quatCur.set(this.quatTo);
        this.anim = null;
      },
    });
  }

  /** Land immediately: no wave, the tiles are simply at their targets. */
  settle() {
    if (this.anim) { this.anim.pause(); this.anim = null; }
    this.posCur.set(this.posTo);
    this.quatCur.set(this.quatTo);
    this.value = 1;
    this.upload(false);
    this.uMorph.value = 1;
  }

  /**
   * Freeze an in-flight wave into posCur/quatCur, reproducing the shader exactly —
   * same per-instance delay, same smoothstep — so a layout change mid-flight starts
   * from where the tiles are actually drawn rather than snapping.
   */
  bake() {
    if (this.anim) { this.anim.pause(); this.anim = null; }
    const { n, posCur, posTo, quatCur, quatTo, _pa, _pb, _qa, _qb } = this;
    const { aFromPD } = this.attrs;
    for (let i = 0; i < n; i++) {
      const a = i * 3, b = i * 4;
      const d = aFromPD.array[b + 3];
      const tl = Math.min(1, Math.max(0, (this.value - d) / Math.max(1 - d, 0.001)));
      const e = tl * tl * (3 - 2 * tl);
      _pa.set(posCur[a], posCur[a + 1], posCur[a + 2]);
      _pb.set(posTo[a], posTo[a + 1], posTo[a + 2]);
      _pa.lerp(_pb, e);
      posCur[a] = _pa.x; posCur[a + 1] = _pa.y; posCur[a + 2] = _pa.z;
      _qa.set(quatCur[b], quatCur[b + 1], quatCur[b + 2], quatCur[b + 3]);
      _qb.set(quatTo[b], quatTo[b + 1], quatTo[b + 2], quatTo[b + 3]);
      _qa.slerp(_qb, e);
      quatCur[b] = _qa.x; quatCur[b + 1] = _qa.y; quatCur[b + 2] = _qa.z; quatCur[b + 3] = _qa.w;
    }
    this.value = 1;
  }

  /**
   * Collapse A and B onto posCur, i.e. "the tiles are exactly here now". This is the
   * handoff out of physics: the sim writes posCur every step and this is what makes
   * the shader draw it, with the morph pinned at 1 so no interpolation is applied.
   */
  flatten() {
    const { n, posCur, quatCur } = this;
    const { aFromPD, aToPos, aQuatA, aQuatB } = this.attrs;
    for (let i = 0; i < n; i++) {
      const a = i * 3, b = i * 4;
      aFromPD.array[b] = aToPos.array[b] = posCur[a];
      aFromPD.array[b + 1] = aToPos.array[b + 1] = posCur[a + 1];
      aFromPD.array[b + 2] = aToPos.array[b + 2] = posCur[a + 2];
      aFromPD.array[b + 3] = 0;
      // again xyz only on aToPos; b+3 there stays whatever the detail cache set
      for (let k = 0; k < 4; k++) {
        aQuatA.array[b + k] = aQuatB.array[b + k] = quatCur[b + k];
      }
    }
    this._flush();
    this.uMorph.value = 1;
  }

  _flush() {
    const { aFromPD, aToPos, aQuatA, aQuatB } = this.attrs;
    aFromPD.needsUpdate = aToPos.needsUpdate = true;
    aQuatA.needsUpdate = aQuatB.needsUpdate = true;
  }
}
