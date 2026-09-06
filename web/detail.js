import * as THREE from 'three';

/**
 * The full-resolution tile cache.
 *
 * The atlas ships every record at one small tier, which is right for 2,936 tiles at
 * arm's length and mush the moment you fly into one. This keeps a second texture —
 * a grid of 256px cells — and lends those cells to whichever tiles are currently
 * big enough on screen to deserve one.
 *
 * OWNERSHIP. Two lanes, and only two, in buffers it shares with the morph:
 *
 *   aMeta.w    which cell a tile is bound to, or -1 for the base atlas
 *   aToPos.w   the cross-fade, 0 -> 1, as a newly bound cell comes in
 *
 * `aToPos.xyz` next door belongs to MorphController and is written every time a
 * layout changes. So nothing here may touch a whole attribute array — `.set()`
 * would blank a morph in flight. Write the lane, never the buffer. The same rule
 * runs the other way in web/morph.js, and the map of who owns what is at the top
 * of app.js.
 *
 * Election is by distance, not by frustum: a tile has to be within the range where
 * it would cover DETAIL_MIN_PX to be worth a request at all, which on a default
 * camera is about eight units. That is why the scene has to be flown into before
 * any of this runs, and why the verifier needs a close-up scene to cover it.
 */
export class DetailCache {
  /**
   * @param n        tile count
   * @param records  DATA.records, read for .th (thumbnail path)
   * @param attrs    { aMeta, aToPos } — two lanes of, never the arrays themselves
   * @param lanes    { detail } index of the detail lane within aMeta
   * @param side     cache texture edge in px; cell is 256
   * @param minPx    on-screen size a tile must reach before it is worth loading
   * @param assetBase prefix for a record's `th` path
   */
  constructor({ n, records, attrs, lanes, side = 2048, cell = 256, minPx = 74,
                assetBase = '../assets/' }) {
    this.n = n;
    this.records = records;
    this.attrs = attrs;
    this.M_DETAIL = lanes.detail;
    this.side = side;
    this.cell = cell;
    this.perRow = side / cell;
    this.slots = this.perRow * this.perRow;
    this.minPx = minPx;
    this.assetBase = assetBase;

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    this.ctx.fillStyle = '#0a0c10';
    this.ctx.fillRect(0, 0, side, side);

    this.texture = new THREE.Texture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;   // no mipmaps: cells change at runtime
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.slotOwner = new Int32Array(this.slots).fill(-1);   // slot -> record, or -1
    this.recordSlot = new Int32Array(n).fill(-1);           // record -> slot, or -1
    this.free = Array.from({ length: this.slots }, (_, i) => i);
    // Decoded images wait here and are blitted at a frame boundary. Drawing straight
    // from onload lets a write land between needsUpdate and the GPU's copy of the
    // canvas, which shows up as a torn cell.
    this.pending = [];
    this.fade = new Map();          // record index -> 0..1, only while fading
    this.inFlight = 0;
    this.filled = 0;
    this.due = 0;
  }

  get canvas() { return this.ctx.canvas; }

  /** What the tests and the HUD ask for. `bound` is read from the buffer itself. */
  get stats() {
    const { aMeta } = this.attrs;
    let bound = 0;
    for (let i = 0; i < this.n; i++) if (aMeta.array[i * 4 + this.M_DETAIL] >= 0) bound++;
    return { slots: this.slots, held: this.slotOwner.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0),
             filled: this.filled, inFlight: this.inFlight, bound };
  }

  /** Screen size of a unit tile at distance d, in pixels. */
  static tilePixels(d, camera) {
    const focal = (innerHeight * 0.5) / Math.tan((camera.fov * Math.PI / 180) * 0.5);
    return focal / Math.max(d, 0.001);
  }

  release(slot) {
    const i = this.slotOwner[slot];
    if (i < 0) return;
    const { aMeta, aToPos } = this.attrs;
    this.slotOwner[slot] = -1;
    this.recordSlot[i] = -1;
    if (aMeta.array[i * 4 + this.M_DETAIL] !== -1) {
      aMeta.array[i * 4 + this.M_DETAIL] = -1; aMeta.needsUpdate = true;
      this.fade.delete(i);
      aToPos.array[i * 4 + 3] = 0; aToPos.needsUpdate = true;   // lane 3 only
    }
    this.free.push(slot);
  }

  /** Drop every slot held by a record that is no longer visible. */
  releaseInactive(active) {
    for (let i = 0; i < this.n; i++) {
      if (!active[i] && this.recordSlot[i] >= 0) this.release(this.recordSlot[i]);
    }
    this.due = 0;
  }

  _load(i, slot) {
    const rec = this.records[i];
    if (!rec.th) { this.release(slot); return; }
    this.inFlight++;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.inFlight--;
      if (this.slotOwner[slot] !== i) return;            // evicted while in flight
      this.pending.push({ i, slot, img });
    };
    img.onerror = () => {
      this.inFlight--;
      if (this.slotOwner[slot] === i) this.release(slot);
    };
    img.src = this.assetBase + rec.th;
  }

  /** Blit whatever decoded since the last frame. Call before rendering. */
  flush() {
    const { aMeta } = this.attrs;
    let wrote = 0;
    while (this.pending.length) {
      const { i, slot, img } = this.pending.shift();
      if (this.slotOwner[slot] !== i) continue;          // evicted while queued
      const sx = (slot % this.perRow) * this.cell;
      const sy = Math.floor(slot / this.perRow) * this.cell;
      const side = Math.min(img.width, img.height);
      if (!side) continue;
      this.ctx.clearRect(sx, sy, this.cell, this.cell);
      // centre-crop to square, matching how tools/build_web.py packs the atlas
      this.ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
                         sx, sy, this.cell, this.cell);
      aMeta.array[i * 4 + this.M_DETAIL] = slot;
      this.fade.set(i, 0);
      this.filled++; wrote++;
    }
    if (wrote) { this.texture.needsUpdate = true; aMeta.needsUpdate = true; }
  }

  /** Advance the cross-fade of every cell that has just arrived. */
  stepFade(dt) {
    if (!this.fade.size) return;
    const { aToPos } = this.attrs;
    for (const [i, v] of this.fade) {
      const nv = v + (1 - v) * Math.min(1, dt * 4.5);
      if (nv > 0.998) { aToPos.array[i * 4 + 3] = 1; this.fade.delete(i); }
      else { this.fade.set(i, nv); aToPos.array[i * 4 + 3] = nv; }
    }
    aToPos.needsUpdate = true;                            // lane 3 only
  }

  /**
   * Re-elect which records hold the cache. Runs a few times a second, not per
   * frame: it walks every record, and a full texture re-upload is not free.
   */
  update(camera, posCur, active) {
    const maxDist = DetailCache.tilePixels(1, camera) / this.minPx;
    const cam = camera.position;
    const near = [];
    for (let i = 0; i < this.n; i++) {
      if (!active[i]) continue;
      const a = i * 3;
      const dx = posCur[a] - cam.x, dy = posCur[a + 1] - cam.y, dz = posCur[a + 2] - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < maxDist * maxDist) near.push([d2, i]);
    }
    near.sort((p, q) => p[0] - q[0]);
    const want = new Set();
    for (let k = 0; k < Math.min(near.length, this.slots); k++) want.add(near[k][1]);

    for (let slot = 0; slot < this.slots; slot++) {
      const owner = this.slotOwner[slot];
      if (owner >= 0 && !want.has(owner)) this.release(slot);
    }
    for (const i of want) {
      if (this.recordSlot[i] >= 0 || !this.free.length) continue;
      if (this.inFlight >= 8) break;                     // keep the network queue short
      const slot = this.free.pop();
      this.slotOwner[slot] = i; this.recordSlot[i] = slot;
      this._load(i, slot);
    }
  }

  /**
   * The per-frame half: blit, then re-elect on a timer. Held off while a morph is in
   * flight, because electing from positions that are still moving picks the wrong
   * tiles and then immediately evicts them.
   */
  tick(dt, camera, posCur, active, settled) {
    this.flush();
    this.due -= dt;
    if (this.due <= 0 && settled) { this.due = 0.22; this.update(camera, posCur, active); }
  }
}
