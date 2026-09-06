import * as THREE from 'three';

/**
 * Where every tile goes, for each arrangement. Pure maths and nothing else — no
 * renderer, no buffers, no morph, no DOM. Given a list of visible records it hands
 * back one [x, y, z, quaternion] per tile plus the group labels that arrangement
 * wants, and the caller decides what to do with them.
 *
 * That split is the point. These are the six functions most likely to be tuned by
 * eye — a pitch, a gap, a bucket boundary — and having them in app.js meant every
 * such tweak sat next to the code that uploads GPU buffers and drives the morph
 * clock. Here a change can only move tiles.
 *
 * Every arrangement is written against `list`, the filtered set, so a layout is
 * recomputed rather than masked when a filter changes. Records not in `list` are
 * exiled to a far shell by fill(), where the shader shrinks and desaturates them.
 */

/** No rotation. Shared, so never mutate it. */
export const FLAT = new THREE.Quaternion();

/**
 * @param mode      grid | sphere | helix | physics | towers | clusters
 * @param total     instance count, i.e. every record whether visible or not
 * @param list      indices of the records currently passing the filters
 * @param records   DATA.records, read for .w (word count) and .m (model)
 * @param viewAspect(landscape) -> aspect to lay out for; lets a layout react to a
 *                  portrait window without this module knowing what a window is
 * @param posCur    current positions — physics alone starts from where tiles are
 * @param physList  which tiles become bodies; only read in physics mode
 * @returns { out, labels }
 */
export function computeLayout(mode, { total, list, records, viewAspect, posCur, physList }) {
  const n = list.length || 1;
  const out = [];
  const labels = [];

  if (mode === 'grid') {
    const cols = Math.max(1, Math.round(Math.sqrt(n * viewAspect(1.9))));
    const gx = 1.5, gy = 1.5;
    list.forEach((idx, k) => {
      const c = k % cols, r = Math.floor(k / cols);
      out[idx] = [(c - cols / 2) * gx, -(r - Math.ceil(n / cols) / 2) * gy, 0, FLAT];
    });
  } else if (mode === 'sphere') {
    // radius from surface density: n tiles of ~1.55 pitch tile the sphere,
    // so it reads as a solid shell rather than scattered confetti
    const R = Math.max(9, Math.sqrt(n * 1.55 * 1.55 / (4 * Math.PI)));
    const mat = new THREE.Matrix4();
    const vUp = new THREE.Vector3();
    const vRight = new THREE.Vector3();
    list.forEach((idx, k) => {
      const y = 1 - (k / Math.max(1, n - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = Math.PI * (3 - Math.sqrt(5)) * k;
      const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).multiplyScalar(R);
      const norm = v.clone().normalize();
      if (Math.abs(norm.y) < 0.9999) {
        vUp.set(0, 1, 0).sub(norm.clone().multiplyScalar(norm.y)).normalize();
        vRight.crossVectors(vUp, norm).normalize();
      } else {
        vUp.set(0, 0, norm.y > 0 ? -1 : 1);
        vRight.set(1, 0, 0);
      }
      mat.makeBasis(vRight, vUp, norm);
      const q = new THREE.Quaternion().setFromRotationMatrix(mat);
      out[idx] = [v.x, v.y, v.z, q];
    });
  } else if (mode === 'helix') {
    const R = Math.max(12, n / 145);
    const perTurn = Math.max(18, Math.round(2 * Math.PI * R / 1.5));
    list.forEach((idx, k) => {
      const a = (k / perTurn) * Math.PI * 2, y = k * (1.5 / perTurn) * 1.9 - n * (1.5 / perTurn) * 0.95;
      const v = new THREE.Vector3(Math.sin(a) * R, y, Math.cos(a) * R);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0));
      out[idx] = [v.x, v.y, v.z, q];
    });
  } else if (mode === 'physics') {
    for (const idx of physList) {
      const a = idx * 3;
      out[idx] = [posCur[a], posCur[a + 1], posCur[a + 2], FLAT];
    }
  } else if (mode === 'towers') {
    // ordered buckets, so this is a histogram: five towers you read left to
    // right, each one image-deep. A ring would hide half of it.
    // presets publish no prompt at all — counting them as "1–25 words" would
    // overstate the short bucket by the whole preset catalogue
    const BUCKETS = ['no prompt text', '1–25 words', '26–75 words', '76–200 words',
                     '201–500 words', '500+ words'];
    const bucket = (w) => w <= 0 ? BUCKETS[0] : w <= 25 ? BUCKETS[1] : w <= 75 ? BUCKETS[2]
      : w <= 200 ? BUCKETS[3] : w <= 500 ? BUCKETS[4] : BUCKETS[5];
    const groups = new Map(BUCKETS.map((b) => [b, []]));
    for (const idx of list) groups.get(bucket(records[idx].w)).push(idx);

    const PITCH = 1.4;
    const dims = BUCKETS.map((b) => {
      const m = groups.get(b).length;
      const cols = Math.max(3, Math.round(Math.sqrt(m / 2.4)));
      return { cols, rows: Math.ceil(m / cols) || 1, w: cols * PITCH };
    });
    const gap = PITCH * 3.2;
    const totalW = dims.reduce((a, d) => a + d.w, 0) + gap * (BUCKETS.length - 1);
    let x = -totalW / 2;
    BUCKETS.forEach((b, gi) => {
      const members = groups.get(b), d = dims[gi];
      const cx = x + d.w / 2; x += d.w + gap;
      members.forEach((idx, k2) => {
        const c = k2 % d.cols, r = Math.floor(k2 / d.cols);
        out[idx] = [cx + (c - d.cols / 2 + 0.5) * PITCH, r * PITCH, 0, FLAT];   // grows upward
      });
      labels.push({ text: b, count: members.length, q: FLAT,
                         pos: new THREE.Vector3(cx, d.rows * PITCH + 2.4, 0) });
    });
  } else if (mode === 'clusters') {
    const groups = new Map();
    for (const idx of list) {
      const k = records[idx].m || 'no model attributed';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(idx);
    }
    // 51 models side by side leaves every tile a speck. Keep the largest
    // groups legible and roll the long tail into one bucket.
    let keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    const CAP = 12;
    if (keys.length > CAP) {
      const tail = keys.slice(CAP);
      const rest = tail.flatMap((k) => groups.get(k));
      tail.forEach((k) => groups.delete(k));
      keys = keys.slice(0, CAP);
      if (rest.length) { const label = `${tail.length} smaller models`; groups.set(label, rest); keys.push(label); }
    }

    // Small multiples, not a ring. One model holds 1,338 of the 2,619 records,
    // so a ring gives wildly unequal groups equal angular space and you can
    // only ever see a narrow arc of it. Blocks in rows all face the camera:
    // nothing shows its back, no label overlaps another, sizes compare directly.
    const PITCH = 1.4, GAP_X = PITCH * 3.4, GAP_Y = PITCH * 6.4;
    const dims = keys.map((k) => {
      const m = groups.get(k).length;
      const cols = Math.max(2, Math.round(Math.sqrt(m * 1.9)));
      const rows = Math.ceil(m / cols);
      return { cols, rows, w: cols * PITCH, h: rows * PITCH };
    });

    // pack into rows aiming at the footprint the screen can actually show
    const area = dims.reduce((a, d) => a + (d.w + GAP_X) * (d.h + GAP_Y), 0);
    const target = Math.sqrt(area * viewAspect(16 / 9));
    const lines = [];
    let cur = [], curW = 0;
    dims.forEach((d, gi) => {
      if (cur.length && curW + d.w + GAP_X > target) { lines.push({ items: cur, w: curW }); cur = []; curW = 0; }
      cur.push(gi); curW += d.w + GAP_X;
    });
    if (cur.length) lines.push({ items: cur, w: curW });

    const lineH = lines.map((L) => Math.max(...L.items.map((gi) => dims[gi].h)) + GAP_Y);
    const totalH = lineH.reduce((a, b) => a + b, 0);
    let y = totalH / 2;
    lines.forEach((L, li) => {
      let x = -L.w / 2;
      const top = y, bottom = y - lineH[li];
      L.items.forEach((gi) => {
        const k = keys[gi], members = groups.get(k), d = dims[gi];
        const cx = x + d.w / 2, cy = bottom + GAP_Y * 0.55 + d.h / 2;
        x += d.w + GAP_X;
        members.forEach((idx, k2) => {
          const c = k2 % d.cols, r = Math.floor(k2 / d.cols);
          out[idx] = [cx + (c - d.cols / 2 + 0.5) * PITCH,
                      cy - (r - d.rows / 2 + 0.5) * PITCH, 0, FLAT];
        });
        labels.push({ text: k, count: members.length, q: FLAT, maxW: d.w + GAP_X * 0.8,
                           pos: new THREE.Vector3(cx, cy + d.h / 2 + 2.9, 0) });
      });
      y = bottom;
    });
  }


  // Unmatched tiles are not hidden — they are pushed to a far shell on the same
  // Fibonacci spiral the sphere uses, where the shader shrinks and desaturates them.
  // Keeping them in the scene is what makes a filter read as a subset of a whole.
  let s = 0;
  for (let i = 0; i < total; i++) {
    if (out[i]) continue;
    const y = 1 - (s / Math.max(1, total - n)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = 2.39996 * s; s++;
    const R = 300;
    out[i] = [Math.cos(th) * rad * R, y * R * 0.6, Math.sin(th) * rad * R, FLAT];
  }

  return { out, labels };
}
