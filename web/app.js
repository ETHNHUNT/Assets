/**
 * Higgsfield Prompt Atlas — 2,619 generations as one instanced mesh.
 *
 * Renderer  three r185 WebGPURenderer. Every tile is one instance of one plane
 *           in a single draw call; the atlas lookup, filter dimming, focus lift
 *           and rounded corners are all TSL, so the same source compiles to
 *           WGSL on WebGPU and GLSL on the WebGL2 fallback.
 * Physics   Rapier 0.20 (SIMD build where the browser supports simd128). Chosen
 *           by benchmark on this exact workload — 2,619 thin boxes collapsing
 *           into a pile — at 7.9 ms/step against 11.9 for the plain build and
 *           33.3 for Jolt.
 */
import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, texture, mix, smoothstep, step as tslStep,
  positionLocal, uniform, normalize,
  pass, mrt, output,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { animate, createSpring } from 'animejs';
import { AtlasAudio } from './audio.js';

// ---------------------------------------------------------------- boot ------
const $ = (s) => document.querySelector(s);
const lbar = $('#lbar'), lmsg = $('#lmsg');
const step = (pct, msg) => { lbar.style.width = pct + '%'; if (msg) lmsg.textContent = msg; };

let DATA, ATLAS, PER_ROW, N;
let renderer, scene, camera, controls, mesh, dust;
let pipeline = null, bloomPass = null, bloomOn = true;
const audio = new AtlasAudio();
/**
 * WebGPU's maxVertexBuffers is 8 and three binds one buffer per attribute, so a
 * shader that references more than eight silently fails to build a pipeline and
 * the mesh renders black. Per-instance data is therefore packed:
 *   aMeta   = (atlas cell, dim, focus, detail slot)
 *   aFromPD = (from-position xyz, stagger delay)
 *   aToPos  = to-position xyz
 *   aQuatA / aQuatB = from/to orientation
 * With position and uv that is seven, and `normal` is deleted since an unlit
 * material never reads it.
 */
let aMeta, aFromPD, aToPos, aQuatA, aQuatB;
const M_CELL = 0, M_DIM = 1, M_FOCUS = 2, M_DETAIL = 3;
const uMorph = uniform(1);                  // 0 = at A, 1 = at B; the shader staggers per tile
const STAGGER = 0.34;                       // fraction of the timeline given over to the wave
let posCur, posTo, quatCur, quatTo;      // morph buffers
let morph = 1;                           // 1 = settled
let active = null;                       // Uint8Array: does record pass filters
let hovered = -1, selected = -1;
let mode = 'grid';
const dimNow = [], focusNow = [];        // eased per-instance values

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1), _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

async function fetchJSON(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!total || !res.body) return res.json();
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    step(6 + (got / total) * 30, `${label} ${(got / 1048576).toFixed(1)} MB`);
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

async function boot() {
  try {
    step(4, 'loading records');
    DATA = await fetchJSON('./data/records.json', 'records');
    N = DATA.records.length;

    const tier = matchMedia('(max-width:820px)').matches ? 'low' : 'high';
    const at = DATA.atlas[tier] || DATA.atlas.high;
    PER_ROW = at.perRow;

    step(40, 'loading atlas');
    const blob = await (await fetch(`./data/atlas-${at.tile}.webp`)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    ATLAS = new THREE.Texture(bmp);
    ATLAS.colorSpace = THREE.SRGBColorSpace;
    ATLAS.flipY = false;                       // atlas row 0 is the top row
    ATLAS.minFilter = THREE.LinearMipmapLinearFilter;
    ATLAS.magFilter = THREE.LinearFilter;
    ATLAS.generateMipmaps = true;
    ATLAS.anisotropy = 4;
    ATLAS.needsUpdate = true;

    step(58, 'starting renderer');
    await initRenderer();
    step(74, 'building scene');
    buildScene();
    buildPipeline();
    buildUI();
    step(88, 'first frame');
    pipeline.render();

    window.__atlas = { THREE, renderer, scene, camera, mesh, controls, audio,
      get pipeline() { return pipeline; }, setBloom,
      get detail() {
        if (!DETAIL) return null;
        return { slots: DETAIL_SLOTS, held: slotOwner.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0),
                 filled: detailFilled, inFlight: detailLoads,
                 bound: Array.from(aMeta.array).filter((v, k) => k % 4 === M_DETAIL && v >= 0).length };
      },
      forceDetail() { detailDue = 0; updateDetailCache(); },
      pickNow() { return pickInstance(); },
      get morph() { return morph; },
      get detailCanvas() { return detailCtx && detailCtx.canvas; },
      get detailTex() { return DETAIL; },
      get atlasTex() { return ATLAS; },
      // instanceMatrix is identity — placement lives in positionNode — so tests
      // that need where a tile actually is have to read this
      get positions() { return posCur; },
      get info() { return renderer.info; },
      // headless screenshots cannot capture a WebGPU swapchain, so verification
      // reads the pixels back off the GPU instead
      // `post` routes through the bloom pipeline; without it you read the raw
      // scene pass and would conclude bloom is missing.
      async readback(n = 256, post = true) {
        const rt = new THREE.RenderTarget(n, n);
        renderer.setRenderTarget(rt);
        if (post && pipeline) pipeline.render(); else renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, n, n);
        let lit = 0, sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const v = buf[i] + buf[i + 1] + buf[i + 2];
          if (v > 24) lit++;
          sum += v;
        }
        rt.dispose();
        return { pixels: buf.length / 4, lit, litPct: +(100 * lit / (buf.length / 4)).toFixed(1),
                 meanRGB: +(sum / (buf.length / 4) / 3).toFixed(1) };
      } };
    step(100, 'ready');
    setTimeout(() => $('#load').classList.add('gone'), 260);
    renderer.setAnimationLoop(tick);
    if (location.hash.length > 1) selectById(location.hash.slice(1), true);
  } catch (e) {
    lmsg.innerHTML = `<span style="color:#ff8080">${String(e.message || e)}</span><br>
      <span style="font-size:10.5px">This page needs to be served over HTTP —
      run <code>python3 -m http.server</code> from the repo root and open
      <code>/web/</code>. Opening the file directly will not work.</span>`;
    console.error(e);
  }
}

// ------------------------------------------------------------ renderer ------
async function initRenderer() {
  // ?webgl=1 forces the fallback path — used to verify both backends render
  // identically, since headless screenshots cannot capture a WebGPU swapchain.
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false, forceWebGL });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const gpu = !!(renderer.backend && renderer.backend.isWebGPUBackend);
  const el = $('#backend');
  el.textContent = gpu ? 'WebGPU' : 'WebGL 2';
  el.title = gpu ? 'Rendering through the WebGPU backend'
                 : 'WebGPU unavailable — three.js fell back to WebGL 2 automatically';
  if (!gpu) { el.style.color = '#ffb454'; el.style.borderColor = '#5a4322';
              el.style.background = 'rgba(70,52,25,.35)'; }
}

// -------------------------------------------------------- detail cache ------
/**
 * Level-of-detail, after the mechanism in YaleDHLab/pix-plot (MIT, 2020) — the
 * technique, not the code: theirs is WebGL/regl and predates TSL by years.
 *
 * The base atlas holds all 2,619 tiles at 64px, which is right at a distance and
 * mush up close. So a second, small texture acts as a *cache* of full-resolution
 * cells, and a per-instance attribute says which source to sample: -1 means the
 * base atlas, anything else is a slot in the cache. As the camera moves, the
 * nearest tiles claim slots and departed ones give them back, so detail follows
 * the viewer for a fixed 16 MB rather than scaling with the collection.
 */
const DETAIL_SIDE = 2048, DETAIL_CELL = 256;
const DETAIL_PER_ROW = DETAIL_SIDE / DETAIL_CELL;          // 8
const DETAIL_SLOTS = DETAIL_PER_ROW * DETAIL_PER_ROW;      // 64 crisp tiles
const DETAIL_MIN_PX = 74;        // only worth loading once a tile is this big on screen
let DETAIL = null, detailCtx = null;
let slotOwner = null;            // slot -> record index, or -1
let recordSlot = null;           // record index -> slot, or -1
let detailFree = [];
let detailLoads = 0, detailFilled = 0, detailDue = 0;
// Decoded images wait here and are blitted at a frame boundary. Drawing straight
// from onload lets a write land between needsUpdate and the GPU's copy of the
// canvas, which shows up as a torn cell.
let detailPending = [];
const detailFade = new Map();          // record index -> 0..1, only while fading

function buildDetailCache() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = DETAIL_SIDE;
  detailCtx = canvas.getContext('2d', { willReadFrequently: false });
  detailCtx.fillStyle = '#0a0c10';
  detailCtx.fillRect(0, 0, DETAIL_SIDE, DETAIL_SIDE);

  DETAIL = new THREE.Texture(canvas);
  DETAIL.colorSpace = THREE.SRGBColorSpace;
  DETAIL.flipY = false;
  DETAIL.minFilter = THREE.LinearFilter;      // no mipmaps: cells change at runtime
  DETAIL.magFilter = THREE.LinearFilter;
  DETAIL.generateMipmaps = false;
  DETAIL.needsUpdate = true;

  slotOwner = new Int32Array(DETAIL_SLOTS).fill(-1);
  recordSlot = new Int32Array(N).fill(-1);
  detailFree = Array.from({ length: DETAIL_SLOTS }, (_, i) => i);
}

/** Screen size of a unit tile at distance d, in pixels. */
function tilePixels(d) {
  const focal = (innerHeight * 0.5) / Math.tan((camera.fov * Math.PI / 180) * 0.5);
  return focal / Math.max(d, 0.001);
}

function releaseSlot(slot) {
  const i = slotOwner[slot];
  if (i < 0) return;
  slotOwner[slot] = -1;
  recordSlot[i] = -1;
  if (aMeta.array[i * 4 + M_DETAIL] !== -1) {
    aMeta.array[i * 4 + M_DETAIL] = -1; aMeta.needsUpdate = true;
    detailFade.delete(i);
    aToPos.array[i * 4 + 3] = 0; aToPos.needsUpdate = true;
  }
  detailFree.push(slot);
  detailPending = detailPending.filter((q) => q.slot !== slot);
}

function loadDetail(i, slot) {
  const rec = DATA.records[i];
  if (!rec.th) { releaseSlot(slot); return; }
  detailLoads++;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    detailLoads--;
    if (slotOwner[slot] !== i) return;                 // evicted while in flight
    detailPending.push({ i, slot, img });
  };
  img.onerror = () => { detailLoads--; if (slotOwner[slot] === i) releaseSlot(slot); };
  img.src = `../assets/${rec.th}`;
}

/** Blit decoded images into the cache and upload once. Called from the loop. */
function flushDetail() {
  if (!detailPending.length) return;
  let wrote = 0;
  while (detailPending.length && wrote < 6) {
    const { i, slot, img } = detailPending.shift();
    if (slotOwner[slot] !== i) continue;               // evicted while queued
    const sx = (slot % DETAIL_PER_ROW) * DETAIL_CELL;
    const sy = Math.floor(slot / DETAIL_PER_ROW) * DETAIL_CELL;
    const side = Math.min(img.width, img.height);
    if (!side) continue;
    detailCtx.clearRect(sx, sy, DETAIL_CELL, DETAIL_CELL);
    // centre-crop to square, matching how tools/build_web.py packs the atlas
    detailCtx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
                        sx, sy, DETAIL_CELL, DETAIL_CELL);
    aMeta.array[i * 4 + M_DETAIL] = slot;
    detailFade.set(i, 0);
    detailFilled++; wrote++;
  }
  if (wrote) { DETAIL.needsUpdate = true; aMeta.needsUpdate = true; }
}

/**
 * Re-elect which records hold the cache. Runs a few times a second, not per
 * frame: it walks every record, and a full texture re-upload is not free.
 */
function updateDetailCache() {
  if (!DETAIL) return;
  const maxDist = tilePixels(1) / DETAIL_MIN_PX;      // distance at which a tile fills DETAIL_MIN_PX
  const cam = camera.position;
  const near = [];
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    const a = i * 3;
    const dx = posCur[a] - cam.x, dy = posCur[a + 1] - cam.y, dz = posCur[a + 2] - cam.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < maxDist * maxDist) near.push([d2, i]);
  }
  near.sort((p, q) => p[0] - q[0]);
  const want = new Set();
  for (let k = 0; k < Math.min(near.length, DETAIL_SLOTS); k++) want.add(near[k][1]);

  for (let slot = 0; slot < DETAIL_SLOTS; slot++) {
    const owner = slotOwner[slot];
    if (owner >= 0 && !want.has(owner)) releaseSlot(slot);
  }
  for (const i of want) {
    if (recordSlot[i] >= 0 || !detailFree.length) continue;
    if (detailLoads >= 8) break;                       // keep the network queue short
    const slot = detailFree.pop();
    slotOwner[slot] = i; recordSlot[i] = slot;
    loadDetail(i, slot);
  }
}

// --------------------------------------------------------------- scene ------
function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080c);
  scene.fog = new THREE.FogExp2(0x07080c, 0.0075);

  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 4000);
  camera.position.set(0, 8, 96);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.55;
  controls.minDistance = 3;
  controls.maxDistance = 700;

  // ---- per-instance data -------------------------------------------------
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.deleteAttribute('normal');            // unlit material; frees a vertex buffer

  const meta = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    meta[i * 4 + M_CELL] = DATA.records[i].i;
    meta[i * 4 + M_DIM] = 1;
    meta[i * 4 + M_FOCUS] = 0;
    meta[i * 4 + M_DETAIL] = -1;            // -1 = sample the base atlas
  }
  aMeta = new THREE.InstancedBufferAttribute(meta, 4);
  aFromPD = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  aToPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);   // xyz + detail fade
  aQuatA = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  aQuatB = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  for (let i = 0; i < N; i++) { aQuatA.array[i * 4 + 3] = 1; aQuatB.array[i * 4 + 3] = 1; }
  geo.setAttribute('aMeta', aMeta);
  geo.setAttribute('aFromPD', aFromPD);
  geo.setAttribute('aToPos', aToPos);
  geo.setAttribute('aQuatA', aQuatA);
  geo.setAttribute('aQuatB', aQuatB);

  // must precede tileMaterial(): the material samples DETAIL if it exists
  const lodOff = new URLSearchParams(location.search).get('lod') === 'off';
  if (!lodOff && !matchMedia('(max-width:820px)').matches) buildDetailCache();

  mesh = new THREE.InstancedMesh(geo, tileMaterial(), N);
  mesh.frustumCulled = false;
  // placement lives entirely in positionNode now; instanceMatrix stays identity
  const _id = new THREE.Matrix4();
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, _id);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  posCur = new Float32Array(N * 3); posTo = new Float32Array(N * 3);
  quatCur = new Float32Array(N * 4); quatTo = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { quatCur[i * 4 + 3] = 1; quatTo[i * 4 + 3] = 1; dimNow[i] = 1; focusNow[i] = 0; }

  active = new Uint8Array(N).fill(1);
  layout('grid', true);
  addDust();
}

function tileMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });

  const meta = attribute('aMeta', 'vec4');
  const dim = meta.y, foc = meta.z;
  const toPD = attribute('aToPos', 'vec4');   // xyz = to-position, w = detail cross-fade

  // An integer index reaches the fragment stage as an interpolated float, and
  // fp32 can land it a hair either side of a whole number — floor()/mod() then
  // resolve neighbouring cells for the quad's two triangles, splitting the tile
  // along its diagonal. Snapping to the nearest integer first makes it exact.
  const snap = (v) => v.add(float(0.5)).floor();

  // flipY is off on both textures, so row 0 is the top of the image
  const cellLocal = vec2(uv().x, uv().y.oneMinus());

  const per = float(PER_ROW);
  const cell = snap(meta.x);
  const auv = vec2(cell.mod(per), cell.div(per).floor()).add(cellLocal).div(per);

  let base = texture(ATLAS, auv).rgb;

  if (DETAIL) {
    // Both textures are sampled and mixed rather than branched: a per-instance
    // branch diverges across a wavefront for no saving on two texture reads.
    const dper = float(DETAIL_PER_ROW);
    const det = meta.w;
    const dsnap = snap(det);
    const duv = vec2(dsnap.mod(dper), dsnap.div(dper).floor()).add(cellLocal).div(dper);
    // cross-fade rather than switch, so sharpening is felt instead of seen
    base = mix(base, texture(DETAIL, duv).rgb, tslStep(float(0), det).mul(toPD.w));
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

function addDust() {
  const n = 2600, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[i * 3] = (Math.random() - 0.5) * 700;
    p[i * 3 + 1] = (Math.random() - 0.5) * 400;
    p[i * 3 + 2] = (Math.random() - 0.5) * 700;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsNodeMaterial({
    color: 0x5866a0, size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.5,
    depthWrite: false,
  });
  dust = new THREE.Points(g, m);
  scene.add(dust);
}

/**
 * Selective bloom, following the three.js r185 pattern from
 * examples/webgpu_postprocessing_bloom_emissive.html: render the scene with MRT
 * so an "emissive" target rides alongside colour, blur that target, add it back.
 * The tile material writes only its glow into that target (see tileMaterial), so
 * the hovered record and the brightest parts of each thumbnail bloom while the
 * rest of the wall stays crisp.
 */
function buildPipeline() {
  const scenePass = pass(scene, camera);
  const mrtNode = mrt({ output: output, emissive: vec4(0, 0, 0, 1) });
  scenePass.setMRT(mrtNode);

  // the glow target never needs more than 8 bits — saves bandwidth on mobile
  const emissiveTexture = scenePass.getTexture('emissive');
  emissiveTexture.type = THREE.UnsignedByteType;

  const colourNode = scenePass.getTextureNode();
  bloomPass = bloom(scenePass.getTextureNode('emissive'), 1.15, 0.55, 0.0);

  pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = colourNode.add(bloomPass);
}

function setBloom(on) {
  bloomOn = on;
  if (bloomPass) bloomPass.strength.value = on ? 1.15 : 0.0;
  const b = $('#bloom');
  if (b) { b.classList.toggle('off', !on); b.title = on ? 'Bloom on' : 'Bloom off'; }
}

// ------------------------------------------------------------- layouts ------
const groupLabels = [];
let labelGroup = null;

/** Canvas-texture plane per cluster — 13 of them, so cost is irrelevant and a
 *  cluster arrangement without names is decoration rather than information. */
function makeLabel(text, count) {
  const pad = 26, fs = 46, sub = 30;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `600 ${fs}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
  const w1 = g.measureText(text).width;
  g.font = `400 ${sub}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
  const w2 = g.measureText(`${count} records`).width;
  c.width = Math.ceil(Math.max(w1, w2) + pad * 2);
  c.height = fs + sub + pad * 2 + 10;

  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(12,15,22,.82)';
  g2.strokeStyle = 'rgba(124,140,255,.45)';
  g2.lineWidth = 3;
  const r = 16, w = c.width, h = c.height;
  g2.beginPath();
  g2.moveTo(r, 0); g2.arcTo(w, 0, w, h, r); g2.arcTo(w, h, 0, h, r);
  g2.arcTo(0, h, 0, 0, r); g2.arcTo(0, 0, w, 0, r); g2.closePath();
  g2.fill(); g2.stroke();

  g2.textBaseline = 'top';
  g2.fillStyle = '#eef0f8';
  g2.font = `600 ${fs}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
  g2.fillText(text, pad, pad - 4);
  g2.fillStyle = '#8f9ac2';
  g2.font = `400 ${sub}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
  g2.fillText(`${count} records`, pad, pad + fs + 6);

  const tex = new THREE.Texture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  mat.fog = false;
  const SCALE = 0.038;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(c.width * SCALE, c.height * SCALE), mat);
  return mesh;
}

function buildLabels() {
  if (labelGroup) {
    labelGroup.traverse((o) => {
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
      o.geometry?.dispose();
    });
    scene.remove(labelGroup);
    labelGroup = null;
  }
  if (!groupLabels.length) return;
  labelGroup = new THREE.Group();
  for (const L of groupLabels) {
    const m = makeLabel(L.text, L.count);
    // a label wider than its own block collides with its neighbours
    if (L.maxW) {
      const w = m.geometry.parameters.width;
      if (w > L.maxW) m.scale.setScalar(Math.max(0.42, L.maxW / w));
    }
    m.position.copy(L.pos);
    m.quaternion.copy(L.q);
    labelGroup.add(m);
  }
  labelGroup.renderOrder = 2;
  scene.add(labelGroup);
}

const MODES = {
  grid: 'Grid', sphere: 'Sphere', helix: 'Helix',
  clusters: 'By model', towers: 'By length', physics: 'Physics',
};

/** Indices that currently pass the filters, in atlas order. */
function activeList() {
  const a = [];
  for (let i = 0; i < N; i++) if (active[i]) a.push(i);
  return a;
}

function setTarget(i, x, y, z, q) {
  posTo[i * 3] = x; posTo[i * 3 + 1] = y; posTo[i * 3 + 2] = z;
  quatTo[i * 4] = q.x; quatTo[i * 4 + 1] = q.y; quatTo[i * 4 + 2] = q.z; quatTo[i * 4 + 3] = q.w;
}

const FLAT = new THREE.Quaternion();

/**
 * Matched records fill the arrangement; unmatched ones are pushed out to a
 * shell so the shape you are looking at is always the shape of your query.
 */
function layout(next, instant) {
  if (morph < 1) bakeCurrent();          // never jump: start from where they are
  if (next) mode = next;
  if (mode !== 'physics') stopPhysics();

  const list = activeList();
  const n = list.length || 1;
  const out = [];
  groupLabels.length = 0;

  if (mode === 'grid') {
    const cols = Math.max(1, Math.round(Math.sqrt(n * 1.9)));
    const gx = 1.5, gy = 1.5;
    list.forEach((idx, k) => {
      const c = k % cols, r = Math.floor(k / cols);
      out[idx] = [(c - cols / 2) * gx, -(r - Math.ceil(n / cols) / 2) * gy, 0, FLAT];
    });
  } else if (mode === 'sphere') {
    // radius from surface density: n tiles of ~1.55 pitch tile the sphere,
    // so it reads as a solid shell rather than scattered confetti
    const R = Math.max(9, Math.sqrt(n * 1.55 * 1.55 / (4 * Math.PI)));
    list.forEach((idx, k) => {
      const y = 1 - (k / Math.max(1, n - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = Math.PI * (3 - Math.sqrt(5)) * k;
      const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).multiplyScalar(R);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), v.clone().normalize());
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
    for (const idx of list) {
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
    for (const idx of list) groups.get(bucket(DATA.records[idx].w)).push(idx);

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
      groupLabels.push({ text: b, count: members.length, q: FLAT,
                         pos: new THREE.Vector3(cx, d.rows * PITCH + 2.4, 0) });
    });
  } else if (mode === 'clusters') {
    const groups = new Map();
    for (const idx of list) {
      const k = DATA.records[idx].m || 'no model attributed';
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

    // pack into rows aiming at a roughly 16:9 overall footprint
    const area = dims.reduce((a, d) => a + (d.w + GAP_X) * (d.h + GAP_Y), 0);
    const target = Math.sqrt(area * (16 / 9));
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
        groupLabels.push({ text: k, count: members.length, q: FLAT, maxW: d.w + GAP_X * 0.8,
                           pos: new THREE.Vector3(cx, cy + d.h / 2 + 2.9, 0) });
      });
      y = bottom;
    });
  }

  // unmatched: pushed to a far shell, shrunk and desaturated by the shader
  let s = 0;
  for (let i = 0; i < N; i++) {
    if (out[i]) { setTarget(i, out[i][0], out[i][1], out[i][2], out[i][3]); continue; }
    const y = 1 - (s / Math.max(1, N - n)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = 2.39996 * s; s++;
    const R = 300;
    setTarget(i, Math.cos(th) * rad * R, y * R * 0.6, Math.sin(th) * rad * R, FLAT);
  }

  buildLabels();
  if (!instant) audio.morph();
  if (instant) {
    if (morphAnim) { morphAnim.pause(); morphAnim = null; }
    posCur.set(posTo); quatCur.set(quatTo);
    morph = 1; uploadMorph(false); uMorph.value = 1;
  } else {
    morphDuration = pickDuration();
    uploadMorph(!REDUCED);
    startMorph();
  }
}

/**
 * Hand the shader a from-state, a to-state and a per-tile delay. Called once per
 * re-arrangement; the interpolation itself then costs the CPU nothing.
 * Tiles that travel furthest are given the smallest delay, so the arrangement
 * empties from its edges and settles inward.
 */
function uploadMorph(stagger = true) {
  let maxD = 0;
  for (let i = 0; i < N; i++) {
    const a = i * 3;
    const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > maxD) maxD = d;
  }
  maxD = Math.sqrt(maxD) || 1;

  for (let i = 0; i < N; i++) {
    const a = i * 3, b = i * 4;
    aFromPD.array[b] = posCur[a]; aFromPD.array[b + 1] = posCur[a + 1]; aFromPD.array[b + 2] = posCur[a + 2];
    aToPos.array[b] = posTo[a]; aToPos.array[b + 1] = posTo[a + 1]; aToPos.array[b + 2] = posTo[a + 2];
    for (let k = 0; k < 4; k++) { aQuatA.array[b + k] = quatCur[b + k]; aQuatB.array[b + k] = quatTo[b + k]; }
    let delay = 0;
    if (stagger) {
      const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
      delay = (1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / maxD) * STAGGER;   // furthest leaves first
    }
    aFromPD.array[b + 3] = delay;
  }
  aFromPD.needsUpdate = aToPos.needsUpdate = true;
  aQuatA.needsUpdate = aQuatB.needsUpdate = true;
}

/** Physics owns the positions while it runs: push them straight to the B slot. */
function writeMatrices() {
  for (let i = 0; i < N; i++) {
    const a = i * 3, b = i * 4;
    aFromPD.array[b] = aToPos.array[b] = posCur[a];
    aFromPD.array[b + 1] = aToPos.array[b + 1] = posCur[a + 1];
    aFromPD.array[b + 2] = aToPos.array[b + 2] = posCur[a + 2];
    aFromPD.array[b + 3] = 0;
    for (let k = 0; k < 4; k++) aQuatA.array[b + k] = aQuatB.array[b + k] = quatCur[b + k];
  }
  aFromPD.needsUpdate = aToPos.needsUpdate = true;
  aQuatA.needsUpdate = aQuatB.needsUpdate = true;
  uMorph.value = 1;
}

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
let morphDuration = 1.1;

/** A short hop and a full re-arrangement should not take the same time. */
function pickDuration() {
  if (REDUCED) return 0.001;
  let sum = 0, n = 0;
  for (let i = 0; i < N; i += 7) {            // sampled: exact is not worth 2,619 sqrts
    if (!active[i]) continue;
    const a = i * 3;
    const dx = posTo[a] - posCur[a], dy = posTo[a + 1] - posCur[a + 1], dz = posTo[a + 2] - posCur[a + 2];
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz); n++;
  }
  const mean = n ? sum / n : 0;
  return Math.min(1.8, Math.max(0.9, 0.75 + mean * 0.012));
}

let morphAnim = null;

/**
 * The master clock stays linear and the shader eases each tile inside its own
 * stagger window — easing here as well would compress the wave and read sluggish.
 */
function startMorph() {
  if (morphAnim) morphAnim.pause();
  const box = { t: 0 };
  morph = 0; uMorph.value = 0;
  morphAnim = animate(box, {
    t: 1,
    duration: morphDuration * 1000,
    ease: 'linear',
    onUpdate: () => { morph = box.t; uMorph.value = morph; },
    onComplete: () => {
      morph = 1; uMorph.value = 1;
      posCur.set(posTo); quatCur.set(quatTo);
      morphAnim = null;
    },
  });
}

/**
 * Freeze the in-flight interpolation into posCur/quatCur, matching the shader
 * exactly — same per-instance delay, same easing — so a layout change mid-flight
 * starts from where the tiles are actually drawn rather than jumping.
 */
function bakeCurrent() {
  if (morphAnim) { morphAnim.pause(); morphAnim = null; }
  for (let i = 0; i < N; i++) {
    const a = i * 3, b = i * 4;
    const d = aFromPD.array[i * 4 + 3];
    const tl = Math.min(1, Math.max(0, (morph - d) / Math.max(1 - d, 0.001)));
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
  morph = 1;
}

// ------------------------------------------------------------- physics ------
// Rapier is a ~3 MB wasm bundle, so it is only fetched when physics is entered.
let RAPIER = null, world = null, bodies = null, ground = null, physReady = false;
let events = null;

// Measured, not guessed: with the threshold at zero, 9 s of a collapsing pile
// produced 681 contact events spanning 0 to 2.4 N — these tiles are thin and
// light. 0.9 keeps the ~20% that read as real knocks; 2.5 maps the hardest of
// them to full loudness.
const CONTACT_THRESHOLD = 0.9;
const IMPACT_SCALE = 2.5;

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

async function startPhysics() {
  const list = activeList();
  if (!list.length) return;
  if (!RAPIER) {
    lmsg.textContent = 'loading physics';
    $('#load').classList.remove('gone');
    step(30, 'loading physics engine');
    const url = simdSupported() ? './vendor/rapier-simd.mjs' : './vendor/rapier-plain.mjs';
    RAPIER = (await import(url)).default;
    await RAPIER.init();
    step(100, 'ready');
    setTimeout(() => $('#load').classList.add('gone'), 200);
  }
  stopPhysics();

  world = new RAPIER.World({ x: 0, y: -24, z: 0 });
  // Contact-force events with a threshold, not raw collision events: a 2,619
  // body pile generates thousands of touches a frame, and only the hard ones
  // are worth hearing.
  events = new RAPIER.EventQueue(true);
  const FLOOR = -26, W = 78;
  ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR - 1, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(W, 1, W), ground);
  for (const [x, z, hx, hz] of [[W, 0, 1, W], [-W, 0, 1, W], [0, W, W, 1], [0, -W, W, 1]]) {
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, FLOOR + 30, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 32, hz), b);
  }

  bodies = new Map();
  for (const i of list) {
    const a = i * 3;
    const rb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(posCur[a], Math.max(posCur[a + 1], FLOOR + 3), posCur[a + 2])
        .setLinearDamping(0.16).setAngularDamping(0.28));
    const col = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.05).setRestitution(0.22).setFriction(0.85)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(CONTACT_THRESHOLD);
    world.createCollider(col, rb);
    rb.setAngvel({ x: (Math.random() - .5) * 2, y: (Math.random() - .5) * 2, z: (Math.random() - .5) * 2 }, true);
    bodies.set(i, rb);
  }
  physReady = true;
  morph = 1;
}

function stopPhysics() {
  if (world) { world.free(); world = null; }
  if (events) { events.free(); events = null; }
  bodies = null; ground = null; physReady = false;
}

function stepPhysics() {
  if (!physReady) return;
  world.step(events);
  if (audio.on) {
    let heard = 0;
    events.drainContactForceEvents((e) => {
      const f = e.totalForceMagnitude();
      if (heard++ > 4) return;                       // the voice cap does the rest
      audio.impact(Math.min(1, f / IMPACT_SCALE));
    });
  } else {
    events.drainContactForceEvents(() => {});        // must drain or it grows
  }
  for (const [i, rb] of bodies) {
    const t = rb.translation(), r = rb.rotation();
    const a = i * 3, b = i * 4;
    posCur[a] = t.x; posCur[a + 1] = t.y; posCur[a + 2] = t.z;
    quatCur[b] = r.x; quatCur[b + 1] = r.y; quatCur[b + 2] = r.z; quatCur[b + 3] = r.w;
  }
  writeMatrices();
}

/** Radial shove — the pile is meant to be disturbed. */
function shove(center, strength = 110, radius = 26) {
  if (!physReady) return;
  for (const rb of bodies.values()) {
    const t = rb.translation();
    const dx = t.x - center.x, dy = t.y - center.y, dz = t.z - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > radius * radius) continue;
    const d = Math.sqrt(d2) || 0.001;
    const f = strength * (1 - d / radius) / d;
    rb.applyImpulse({ x: dx * f, y: dy * f + strength * 0.22, z: dz * f }, true);
  }
}

// --------------------------------------------------------------- picking ----
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2(-9, -9);
let pointerMoved = false, downAt = null;

addEventListener('pointermove', (e) => {
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerMoved = true;
  const tip = $('#tip');
  if (tip.classList.contains('on')) {
    tip.style.left = Math.min(e.clientX + 16, innerWidth - 310) + 'px';
    tip.style.top = Math.min(e.clientY + 16, innerHeight - 90) + 'px';
  }
});
addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return;                       // that was an orbit drag
  if (hovered >= 0) selectIndex(hovered);
  else if (physReady) {                        // empty space in physics mode: shove
    ray.setFromCamera(ptr, camera);
    const at = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 20), at)) shove(at);
  }
});

/** Visual half-extent of a tile, matching the scale the shader applies. */
function tileHalf(i) {
  return 0.5 * (1 + focusNow[i] * 0.30) * (0.40 + 0.60 * dimNow[i]);
}

const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
const _inv = new THREE.Matrix4(), _lo = new THREE.Vector3(), _ld = new THREE.Vector3();
const _cand = [];

/**
 * three's InstancedMesh.raycast intersects all 2,619 instances — 9.3 ms per
 * pointer move, over half a 60 fps frame, spent exactly while the user is
 * interacting. A BVH does not help: the geometry is one quad, so the cost is
 * the instance loop. Reject on perpendicular distance from the ray first (a
 * dot product per tile, no matrix work), then intersect only the survivors.
 */
function pickInstance() {
  ray.setFromCamera(ptr, camera);
  _ro.copy(ray.ray.origin); _rd.copy(ray.ray.direction);
  _cand.length = 0;

  const MAX_PERP2 = 0.92 * 0.92;         // half-diagonal of a focused tile, squared
  for (let i = 0; i < N; i++) {
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
    const h = tileHalf(i);
    if (Math.abs(_lo.x + _ld.x * t) <= h && Math.abs(_lo.y + _ld.y * t) <= h) return i;
  }
  return -1;
}

function pick() {
  if (!pointerMoved) return;
  pointerMoved = false;
  // mid-morph the CPU copy of the positions is the start of the flight, not
  // where the tiles are drawn, so a hover then lands on the wrong tile
  const id = morph < 1 ? -1 : pickInstance();
  if (id === hovered) return;
  hovered = id;
  easeSettled = false;
  const tip = $('#tip');
  if (id < 0) { tip.classList.remove('on'); document.body.style.cursor = ''; return; }
  const r = DATA.records[id];
  audio.hover(r);
  tip.innerHTML = `<b>${esc(r.n || r.t || 'Prompt')}</b>
    <i>${esc(r.m || 'no model')} · ${r.w} words · ${esc(r.k || '')}</i>`;
  tip.classList.add('on');
  document.body.style.cursor = 'pointer';
}

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// -------------------------------------------------------------- detail ------
function selectIndex(i) {
  selected = i;
  audio.select();
  easeSettled = false;
  const r = DATA.records[i];
  $('#dname').textContent = r.n || r.t || 'Prompt';
  $('#dimg').src = `../assets/${r.th}`;
  $('#dprompt').textContent = r.p || '(this preset publishes no prompt text)';
  $('#dcopy').style.display = r.p ? '' : 'none';
  const tags = [];
  if (r.m) tags.push(`<span class="t m">${esc(r.m)}</span>`);
  if (r.t) tags.push(`<span class="t">${esc(r.t)}</span>`);
  r.s.slice(0, 3).forEach((x) => tags.push(`<span class="t">${esc(x)}</span>`));
  r.v.slice(0, 2).forEach((x) => tags.push(`<span class="t">${esc(x)}</span>`));
  if (r.k) tags.push(`<span class="t">${esc(r.k)}</span>`);
  if (r.g) tags.push(`<span class="t">${esc(r.g)}</span>`);
  $('#dtags').innerHTML = tags.join('');
  $('#drid').textContent = r.id;
  $('#dsrc').textContent = r.u; $('#dsrc').href = r.u;
  $('#dfull').textContent = r.f ? 'Full-resolution original ↗' : '';
  $('#dfull').href = r.f || '#';
  $('#detail').classList.add('open');
  history.replaceState(null, '', '#' + r.id);
  flyTo(i);
}

function selectById(id, instant) {
  const i = DATA.records.findIndex((r) => r.id === id);
  if (i < 0) return;
  if (!active[i]) { resetFilters(); }
  selectIndex(i);
  if (instant) controls.update();
}

/** Fit the camera to the tiles that are actually showing. */
function frameCamera(preferDir) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const src = physReady ? posCur : posTo;   // the sim owns positions in physics mode
  let any = false;
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    box.expandByPoint(v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]));
    any = true;
  }
  for (const L of groupLabels) box.expandByPoint(v.copy(L.pos).addScalar(1.6));
  if (!any) return;
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // Fit the box against both FOV axes. A bounding-sphere fudge factor is fine
  // for the sphere but crops the helix top and bottom and the towers at the
  // sides, because those are nothing like spherical.
  const tanV = Math.tan((camera.fov * Math.PI / 180) / 2);
  const tanH = tanV * camera.aspect;
  const depth = size.z * 0.5;
  const dist = Math.max(6,
    (size.y * 0.5) / tanV + depth,
    (size.x * 0.5) / tanH + depth) * 1.06;
  // One fixed fog density cannot serve a 40-unit grid and a 300-unit carousel:
  // tie it to the framed distance so every arrangement gets the same amount of
  // atmosphere instead of the big ones going black.
  if (scene.fog) scene.fog.density = Math.min(0.02, Math.max(0.0007, 0.5 / dist));

  const dir = preferDir ? preferDir.clone().normalize()
                        : camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.set(0, 0.18, 1).normalize();
  // keep the subject clear of the detail panel when it is open
  const toP = centre.clone().add(dir.multiplyScalar(dist));
  const toT = centre.clone();
  if ($('#detail').classList.contains('open') && innerWidth > 820) {
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const shift = right.multiplyScalar(dist * 0.16);
    toP.add(shift); toT.add(shift);
  }
  setFly(controls.target.clone(), toT, camera.position.clone(), toP);
}

let fly = null, flyAnim = null, physFrameTimer = 0;

/** Weighted camera move: a spring settles instead of stopping dead. */
function setFly(fromT, toT, fromP, toP) {
  if (flyAnim) flyAnim.pause();
  const fromDir = fromP.clone().sub(fromT);
  const toDir = toP.clone().sub(toT);
  const fromR = fromDir.length() || 0.001, toR = toDir.length() || 0.001;
  fromDir.divideScalar(fromR); toDir.divideScalar(toR);
  const box = { t: 0 };
  fly = { box, fromT, toT, fromDir, fromR, toR,
          turn: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir) };
  flyAnim = animate(box, {
    t: 1,
    duration: REDUCED ? 1 : 1000,
    ease: REDUCED ? 'linear' : createSpring({ stiffness: 92, damping: 19, mass: 1.1 }),
    onComplete: () => { fly = null; flyAnim = null; },
  });
}
function flyTo(i) {
  const a = i * 3;
  const target = new THREE.Vector3(posCur[a], posCur[a + 1], posCur[a + 2]);
  const dir = camera.position.clone().sub(controls.target).normalize();
  setFly(controls.target.clone(), target,
         camera.position.clone(), target.clone().add(dir.multiplyScalar(9)));
}

function closeDetail() {
  selected = -1;
  $('#detail').classList.remove('open');
  history.replaceState(null, '', location.pathname + location.search);
}

// ----------------------------------------------------------------- UI -------
function buildUI() {
  const modes = $('#modes');
  for (const [k, label] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.mode = k;
    if (k === mode) b.classList.add('on');
    b.onclick = async () => {
      [...modes.children].forEach((c) => c.classList.toggle('on', c === b));
      $('#foot').classList.toggle('phys', k === 'physics');
      const elevated = new THREE.Vector3(0, 0.62, 1);
      if (k === 'physics') {
        layout('physics');
        await startPhysics();
        frameCamera(elevated);
        // the pile spreads as it falls, so fit it again once it has settled
        clearTimeout(physFrameTimer);
        physFrameTimer = setTimeout(() => { if (physReady) frameCamera(elevated); }, 2600);
      }
      else {
        layout(k);
        frameCamera(k === 'clusters' || k === 'towers'
          ? new THREE.Vector3(0, 0.13, 1) : undefined);
      }
    };
    modes.appendChild(b);
  }

  const uniq = (fn) => [...new Set(DATA.records.flatMap(fn).filter(Boolean))].sort();
  fill('#f-tool', uniq((r) => [r.t]));
  fill('#f-model', uniq((r) => [r.m]));
  fill('#f-style', uniq((r) => r.s));
  function fill(sel, vals) {
    const el = $(sel);
    for (const v of vals) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v; el.appendChild(o);
    }
    el.onchange = applyFilters;
  }
  $('#f-kind').onchange = applyFilters;
  $('#reset').onclick = resetFilters;
  $('#q').oninput = debounce(applyFilters, 180);
  const sndBtn = $('#sound');
  sndBtn.onclick = async () => {
    const on = await audio.toggle();
    sndBtn.classList.toggle('off', !on);
    sndBtn.title = on ? 'Sound on' : 'Sound off';
    sndBtn.setAttribute('aria-pressed', String(on));
    if (on) audio.select();                 // confirm audibly that it worked
  };
  $('#bloom').onclick = () => {
    setBloom(!bloomOn);
    $('#bloom').setAttribute('aria-pressed', String(bloomOn));
  };
  $('#dclose').onclick = closeDetail;
  $('#dcopy').onclick = copyPrompt;
  $('#dsimilar').onclick = showSimilar;

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDetail(); $('#q').blur(); }
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  applyFilters();
}

let lastCount = -1;
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function applyFilters() {
  const q = $('#q').value.trim().toLowerCase();
  const tool = $('#f-tool').value, model = $('#f-model').value;
  const style = $('#f-style').value, kind = $('#f-kind').value;
  let n = 0;
  for (let i = 0; i < N; i++) {
    const r = DATA.records[i];
    const ok = (!tool || r.t === tool) && (!model || r.m === model) &&
               (!style || r.s.includes(style)) && (!kind || r.k === kind) &&
               (!q || r.p.toLowerCase().includes(q) || r.n.toLowerCase().includes(q) ||
                     r.m.toLowerCase().includes(q));
    active[i] = ok ? 1 : 0;
    if (ok) n++;
  }
  if (DETAIL) {
    for (let i = 0; i < N; i++) if (!active[i] && recordSlot[i] >= 0) releaseSlot(recordSlot[i]);
    detailDue = 0;
  }
  stageFilterSweep();
  easeSettled = false;
  $('#count').textContent = `${n.toLocaleString()} of ${N.toLocaleString()}`;
  $('#empty').classList.toggle('on', n === 0);
  const wasNarrow = lastCount <= N * 0.25, isNarrow = n <= N * 0.25;
  lastCount = n;
  layout(null);
  if (mode === 'physics' && n) startPhysics();
  // re-frame when a query meaningfully changes how much is on screen, so a
  // narrow result is not left as a speck in the distance
  if (n && (isNarrow !== wasNarrow || isNarrow)) frameCamera();
}

/**
 * Dimming 2,619 tiles at once reads as a light switch. Give each a delay by how
 * far it is from what the camera is looking at, and the result resolves outward
 * from the centre of the view instead — the same wave the layout morph uses.
 */
const FILTER_STAGGER = 0.30;             // seconds between the first tile and the last
let filterDelay = null;                  // allocated on the first filter change
let filterT = FILTER_STAGGER;            // >= the longest delay means "nothing pending"

function stageFilterSweep() {
  if (!filterDelay || filterDelay.length !== N) filterDelay = new Float32Array(N);
  if (REDUCED) { filterDelay.fill(0); filterT = FILTER_STAGGER; return; }
  const c = controls.target;
  let maxD = 0;
  for (let i = 0; i < N; i++) {
    const a = i * 3;
    const dx = posCur[a] - c.x, dy = posCur[a + 1] - c.y, dz = posCur[a + 2] - c.z;
    const d = dx * dx + dy * dy + dz * dz;
    filterDelay[i] = d;
    if (d > maxD) maxD = d;
  }
  maxD = Math.sqrt(maxD) || 1;
  for (let i = 0; i < N; i++) filterDelay[i] = Math.sqrt(filterDelay[i]) / maxD * FILTER_STAGGER;
  filterT = 0;
}

function resetFilters() {
  $('#q').value = ''; $('#f-tool').value = ''; $('#f-model').value = '';
  $('#f-style').value = ''; $('#f-kind').value = '';
  applyFilters();
}

function showSimilar() {
  if (selected < 0) return;
  const r = DATA.records[selected];
  $('#q').value = '';
  $('#f-model').value = r.m || '';
  $('#f-style').value = r.s[0] || '';
  $('#f-tool').value = ''; $('#f-kind').value = '';
  applyFilters();
}

function copyPrompt() {
  const b = $('#dcopy'), text = DATA.records[selected]?.p || '';
  const done = (msg, cls) => {
    b.textContent = msg; if (cls) b.classList.add(cls);
    setTimeout(() => { b.textContent = 'Copy prompt'; b.classList.remove('ok'); }, 1300);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    done(ok ? 'Copied ✓' : 'Press ⌘/Ctrl+C', ok ? 'ok' : null);
  };
  if (navigator.clipboard && isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done('Copied ✓', 'ok'), fallback);
  } else fallback();
}

// ---------------------------------------------------------------- loop ------
let last = performance.now(), fpsAcc = 0, fpsN = 0;
let easeSettled = false;
const _camPrev = new THREE.Vector3();

function tick() {
  const now = performance.now();
  const raw = (now - last) / 1000;      // real elapsed, for the meter
  const dt = Math.min(0.05, raw);       // clamped, so a stall cannot jump the sim
  last = now;

  pick();

  if (detailFade.size) {
    for (const [i, v] of detailFade) {
      const nv = v + (1 - v) * Math.min(1, dt * 4.5);
      if (nv > 0.998) { aToPos.array[i * 4 + 3] = 1; detailFade.delete(i); }
      else { detailFade.set(i, nv); aToPos.array[i * 4 + 3] = nv; }
    }
    aToPos.needsUpdate = true;
  }

  // ease per-instance dim/focus toward their targets. `easeSettled` skips the
  // whole 2,619-wide sweep once nothing is moving, which is most of the time.
  let touched = false;
  if (filterT < FILTER_STAGGER) { filterT += dt; touched = true; }
  if (!easeSettled) for (let i = 0; i < N; i++) {
    // a tile holds its brightness until its own delay has elapsed
    const dTo = !filterDelay || filterT >= filterDelay[i] ? (active[i] ? 1 : 0) : dimNow[i];
    const fTo = (i === hovered ? 1 : 0) + (i === selected ? 0.7 : 0);
    const d = dimNow[i] + (dTo - dimNow[i]) * Math.min(1, dt * 6);
    const f = focusNow[i] + (Math.min(1, fTo) - focusNow[i]) * Math.min(1, dt * 10);
    if (Math.abs(d - dimNow[i]) > 1e-4) { dimNow[i] = d; aMeta.array[i * 4 + M_DIM] = d; touched = true; }
    if (Math.abs(f - focusNow[i]) > 1e-4) { focusNow[i] = f; aMeta.array[i * 4 + M_FOCUS] = f; touched = true; }
  }
  if (touched) aMeta.needsUpdate = true; else easeSettled = true;

  if (physReady) stepPhysics();

  // re-elect cache holders a few times a second; walking every record and
  // re-uploading the cache texture is not worth doing per frame
  if (DETAIL) {
    flushDetail();                       // blit before this frame's render
    detailDue -= dt;
    if (detailDue <= 0 && morph >= 1) { detailDue = 0.22; updateDetailCache(); }
  }

  if (fly) {
    const e = fly.box.t;
    controls.target.lerpVectors(fly.fromT, fly.toT, e);
    // Arc around the target rather than cutting a straight line through the
    // scene: slerp the view direction, lerp the distance.
    _qa.identity().slerp(fly.turn, e);
    _pa.copy(fly.fromDir).applyQuaternion(_qa)
       .multiplyScalar(fly.fromR + (fly.toR - fly.fromR) * e);
    camera.position.copy(controls.target).add(_pa);
  }

  if (labelGroup) {
    const a = physReady ? 0 : morph;
    labelGroup.visible = a > 0.05;
    labelGroup.children.forEach((m) => {
      m.material.opacity = a;
      m.quaternion.copy(camera.quaternion);
    });
  }
  if (audio.on) {
    const d = camera.position.distanceTo(_camPrev);
    _camPrev.copy(camera.position);
    audio.motion(d / Math.max(dt, 1e-3) / 40);
  }
  if (dust) dust.rotation.y += dt * 0.006;
  controls.update();
  if (pipeline) pipeline.render(); else renderer.render(scene, camera);

  // measure with real elapsed time: accumulating the clamped dt reports a
  // flattering number and a late one exactly when frames are slow
  fpsAcc += raw; fpsN++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsN / fpsAcc);
    const held = DETAIL ? slotOwner.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0) : 0;
    $('#fps').textContent = `${fps} fps · ${N.toLocaleString()} tiles · 1 draw call` +
      (DETAIL ? ` · ${held}/${DETAIL_SLOTS} full-res` : '') +
      (physReady ? ` · ${bodies.size.toLocaleString()} rigid bodies` : '');
    fpsAcc = 0; fpsN = 0;
  }
}

addEventListener('hashchange', () => {
  if (location.hash.length > 1) selectById(location.hash.slice(1));
});

boot();
