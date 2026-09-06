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
import { PhysicsWorld } from './physics.js';
import { MorphController } from './morph.js';
import { computeLayout, FLAT } from './layouts.js';
import { DetailCache } from './detail.js';
import { Highlight } from './highlight.js';

// --------------------------------------------------------------- flags ------
/**
 * Subsystem switches, read once from the query string. Every one of these turns
 * something OFF, so the default URL is the full experience and a flag can only
 * subtract — which is what makes them safe to leave in.
 *
 *   ?webgl      force the WebGL2 backend instead of WebGPU
 *   ?lod=off    no runtime high-res detail cache; base atlas only
 *   ?dust=0     no ambient particles (they are seeded with Math.random() and
 *               rotate every frame, so they have to go for a stable capture)
 *   ?bloom=0    no bloom contribution
 *   ?audio=0    no procedural sound, and no audio context at all
 *   ?physics=0  physics mode refuses to start
 *
 * The one exception to "only subtracts" is ?seed=<int>, which subtracts something
 * else — randomness. Physics seeds every body's spin with Math.random(), so the
 * pile settles differently every run and cannot be compared against a baseline.
 * With a seed, each startPhysics() draws from a fresh stream of that seed, so the
 * same seed gives the same pile no matter what else has consumed randomness first.
 *
 * tools/verify_web.py drives the page with dust and audio off so a frame is
 * reproducible, and with a seed so the physics pile is too.
 */
const PARAMS = new URLSearchParams(location.search);
const off = (k) => { const v = PARAMS.get(k); return v === '0' || v === 'off' || v === 'false'; };
const FLAGS = {
  webgl: PARAMS.has('webgl'),
  lod: !off('lod'),
  dust: !off('dust'),
  bloom: !off('bloom'),
  audio: !off('audio'),
  physics: !off('physics'),
  seed: PARAMS.has('seed') ? (parseInt(PARAMS.get('seed'), 10) | 0) : null,
};

/**
 * mulberry32 — 32 bits of state, no dependencies, and good enough for jitter whose
 * only requirement is that it repeat. Not for anything that needs to be unguessable.
 */
function mulberry32(a) {
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/** A fresh stream, so a caller's sequence does not depend on who drew before it. */
const stream = () => FLAGS.seed === null ? Math.random : mulberry32(FLAGS.seed);

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
/**
 * Per-instance buffer layout — the whole of it, in one place.
 *
 * WebGPU guarantees only 8 vertex buffers, and the geometry already spends two
 * (position, uv), so every per-instance value is packed into five vec4s rather
 * than given an attribute of its own. Nothing here is spare: adding a sixth
 * attribute means repacking, not appending.
 *
 *   aMeta    .x  atlas cell index          .y  dim   0 filtered out .. 1 lit
 *            .z  focus 0 .. 1 (hover+select) .w  detail slot, -1 = base atlas
 *   aFromPD  .xyz  morph START position     .w  this tile's stagger delay 0 .. 1
 *   aToPos   .xyz  morph END position       .w  detail cross-fade 0 .. 1
 *   aQuatA   .xyzw morph START orientation
 *   aQuatB   .xyzw morph END orientation
 *
 * The shader interpolates A->B by a global uMorph, offset by each tile's own
 * delay, so a re-arrangement is a wave rather than a jump and costs no CPU per
 * frame. Which means: a tile's drawn position is NOT instanceMatrix (that stays
 * identity) and is not posCur either while a morph is in flight — it is the
 * interpolation of these two buffers. MorphController.bake() collapses the two
 * back into one, and __atlas.positions exposes posCur for tests that need it.
 *
 * OWNERSHIP is per CHANNEL, not per buffer. An earlier version of this comment
 * said one system writes these at a time; that was never true, and a refactor
 * that believed it would corrupt the LOD fade:
 *
 *   aFromPD  .xyz .w        MorphController          (web/morph.js)
 *   aToPos   .xyz           MorphController
 *   aToPos   .w             DetailCache              (web/detail.js) — concurrent
 *   aQuatA, aQuatB          MorphController
 *   aMeta    .x             set once at build
 *   aMeta    .y .z          the hover/filter easing in tick()
 *   aMeta    .w             DetailCache              — slot binding
 *
 * So `aToPos` has two writers at the same instant, and so does `aMeta`. They do
 * not collide only because each touches its own lanes. The rule that matters is
 * therefore: write channels, never whole arrays. A `.set()` over an attribute
 * would be shorter and would blank whatever the other owner had just put there.
 *
 * PhysicsWorld is the one exception, and it is an exception about posCur rather
 * than about these buffers: while it runs it owns posCur/quatCur outright, and
 * it reaches the GPU through MorphController.flatten() rather than writing here
 * itself. That is the handoff — bake() on the way in, flatten() on the way out.
 */
const M_CELL = 0, M_DIM = 1, M_FOCUS = 2, M_DETAIL = 3;
const uMorph = uniform(1);                  // 0 = at A, 1 = at B; the shader staggers per tile
const STAGGER = 0.34;                       // fraction of the timeline given over to the wave
let morphCtl = null;                     // owns the four buffers below; see web/morph.js
let posCur, posTo, quatCur, quatTo;      // aliases into morphCtl, for readability at call sites
let active = null;                       // Uint8Array: does record pass filters
let hovered = -1, selected = -1;
let mode = 'grid';
let highlight = null;                    // owns aMeta.y/.z; see web/highlight.js

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

    const tier = (COARSE || SMALL) ? 'low' : 'high';   // device class, not orientation
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
      get detail() { return detail ? detail.stats : null; },
      forceDetail() { if (detail) { detail.due = 0; detail.update(camera, posCur, active); } },
      pickNow() { return pickInstance(); },

      /**
       * Aim at a normalised device coordinate and pick, the way a pointer would.
       * Together with project() this makes picking checkable without a single pixel:
       * a tile's centre, projected to NDC and then picked, has to come back as that
       * tile. Pure maths on both sides, so the answer is the same on any machine —
       * which a rendered frame is not.
       */
      pickAt(x, y) { ptr.set(x, y); return pickInstance(); },

      /** Where tile i's centre lands in NDC, given the camera as it stands. */
      project(i) {
        const v = new THREE.Vector3(posCur[i * 3], posCur[i * 3 + 1], posCur[i * 3 + 2]);
        v.project(camera);
        return [v.x, v.y, v.z];
      },
      get morph() { return morphCtl.value; },
      get detailCanvas() { return detail && detail.canvas; },
      get detailTex() { return detail && detail.texture; },
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
      },

      /**
       * A perceptual fingerprint of the current frame: mean luma over a cells x
       * cells grid, quantised to 0-255.
       *
       * Comparing frames byte-for-byte is useless here — a software rasteriser
       * and a real GPU disagree in the low bits of every antialiased edge — but
       * a coarse luma grid is stable across both while still moving the moment a
       * tile lands somewhere else. That is exactly the regression a refactor of
       * the layout or morph path can introduce.
       *
       * `n` must keep bytesPerRow a multiple of 256, i.e. a multiple of 64.
       */
      async signature(n = 512, cells = 16) {
        const rt = new THREE.RenderTarget(n, n);
        renderer.setRenderTarget(rt);
        if (pipeline) pipeline.render(); else renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, n, n);
        rt.dispose();
        const cell = n / cells, out = new Array(cells * cells).fill(0);
        for (let y = 0; y < n; y++) {
          const cy = Math.min(cells - 1, (y / cell) | 0);
          for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            const luma = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
            out[cy * cells + Math.min(cells - 1, (x / cell) | 0)] += luma;
          }
        }
        const per = cell * cell;
        return out.map((v) => Math.round(v / per));
      },

      /** Drive a layout from a test without going through the DOM. */
      setLayout(m, instant = true) { layout(m, instant); },

      /**
       * Enter physics and advance it a fixed number of steps, synchronously.
       *
       * The pile cannot be captured the way a layout is. A layout settles and then
       * holds still, so a test can wait for `settled`; physics never settles, so the
       * only stable thing to compare is "exactly N steps from a known start". Driving
       * the steps here rather than letting tick() do it also takes rAF out of the
       * loop, which a background tab throttles to nothing.
       *
       * Reproducible only under ?seed — without one the spins are Math.random().
       */
      async physics(steps = 240, from = 'grid') {
        // Physics mode seeds itself from wherever the tiles currently are, so without
        // a known starting layout the pile would depend on which scene ran before it.
        layout(from, true);
        layout('physics', true);
        await startPhysics();
        if (!physics.ready) return null;
        for (let k = 0; k < steps; k++) physics.step();
        return { bodies: physics.count, steps, seeded: FLAGS.seed !== null };
      },
      /**
       * Put the camera somewhere and make it stay there.
       *
       * Assigning camera.position is not enough, and quietly was not for a long time.
       * A camera flight outranks it — tick() re-derives the position from `fly` every
       * frame until the animation ends — and one runs for about a second after boot.
       * So an early park slid from (0, 0, 96) to (-0.75, 7.01, 75.16) within 600 ms,
       * most of the way to a different shot, while a later one held. Two framings of
       * the same scene up to maxD 93 apart, and which you got depended on how many
       * renders had already happened.
       *
       * So: cancel the flight first, then damping off and flush the pending deltas
       * through update() before re-asserting the position update() may have moved.
       * Only tests call this, so the interactive feel is untouched.
       */
      park(x, y, z) {
        // A camera flight outranks anything written to camera.position: tick() re-derives
        // the position from `fly` on every frame until the animation ends. One is still
        // running for a second or so after boot, which is what the drift actually was.
        if (flyAnim) { flyAnim.pause(); flyAnim = null; }
        fly = null;
        clearTimeout(physFrameTimer);
        controls.enableDamping = false;
        camera.position.set(x, y, z);
        controls.target.set(0, 0, 0);
        controls.update();                 // applies and zeroes the pending deltas
        camera.position.set(x, y, z);      // update() may have moved it; this is the truth
        controls.target.set(0, 0, 0);
        camera.updateMatrixWorld(true);
      },
      get settled() { return morphCtl.settled; },
      get physicsWorld() { return physics; },
      get highlight() { return highlight; },

      /**
       * Drive the filter and the hover the way a person does, minus the parts a test
       * cannot wait on. setFilter writes the same input applyFilters() reads and calls
       * it directly, so it takes the real path without the 180 ms debounce; hover sets
       * what pick() would have set had the pointer been over tile i.
       *
       * These exist because the two lanes highlight.js owns are invisible to a plain
       * capture: nothing in a parked scene is filtered or hovered, so dim sits at 1 and
       * focus at 0 and the easing never runs. A baseline without them proves only that
       * everything else still draws.
       */
      setFilter(q) { $('#q').value = q; applyFilters(); return $('#count').textContent; },
      hover(i) { hovered = i; highlight.invalidate(); },
      clearHighlight() { hovered = -1; selected = -1; $('#q').value = ''; applyFilters(); },
      get flags() { return { ...FLAGS }; },
      get counts() { return { instances: N, active: active.reduce((a, v) => a + v, 0) }; },
    };
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
  const forceWebGL = FLAGS.webgl;
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
 * the viewer for a fixed budget rather than scaling with the collection.
 */
// A finger has no hover state and fires no pointermove on a clean tap, so the
// whole hover path is not merely useless on touch, it is actively wrong.
const COARSE = matchMedia('(hover: none), (pointer: coarse)').matches;
// Must match the CSS breakpoint below: a phone held sideways is 844px wide and
// would otherwise get the desktop rail, which runs off the bottom of a 390px
// viewport and takes the filters with it.
const SMALL = matchMedia('(max-width:820px), (max-height:520px)').matches;

// A phone gets the 32px atlas tier, so a tile it pinches into is mush without
// this — the cache matters more on mobile than on desktop, not less. It is the
// budget that shrinks: 1024² is 4 MB against the desktop's 16 MB, holding 16
// cells at the same 256px crispness.
const DETAIL_SIDE = (COARSE || SMALL) ? 1024 : 2048;
const DETAIL_MIN_PX = 74;        // only worth loading once a tile is this big on screen
let detail = null;               // DetailCache; owns aMeta.w and aToPos.w, see web/detail.js


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

  // must precede tileMaterial(): the material samples the cache texture if it exists
  highlight = new Highlight({
    n: N, aMeta, lanes: { dim: M_DIM, focus: M_FOCUS }, reduced: REDUCED,
  });

  if (FLAGS.lod) {
    detail = new DetailCache({
      n: N, records: DATA.records, attrs: { aMeta, aToPos },
      lanes: { detail: M_DETAIL }, side: DETAIL_SIDE, minPx: DETAIL_MIN_PX,
    });
  }

  mesh = new THREE.InstancedMesh(geo, tileMaterial(), N);
  mesh.frustumCulled = false;
  // placement lives entirely in positionNode now; instanceMatrix stays identity
  const _id = new THREE.Matrix4();
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, _id);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  morphCtl = new MorphController({
    n: N, uMorph, stagger: STAGGER,
    attrs: { aFromPD, aToPos, aQuatA, aQuatB },
  });
  ({ posCur, posTo, quatCur, quatTo } = morphCtl);
  for (let i = 0; i < N; i++) { quatCur[i * 4 + 3] = 1; quatTo[i * 4 + 3] = 1; }

  active = new Uint8Array(N).fill(1);
  layout('grid', true);
  if (FLAGS.dust) addDust();
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

function addDust() {
  const n = 2600, p = new Float32Array(n * 3), dr = stream();
  for (let i = 0; i < n; i++) {
    p[i * 3] = (dr() - 0.5) * 700;
    p[i * 3 + 1] = (dr() - 0.5) * 400;
    p[i * 3 + 2] = (dr() - 0.5) * 700;
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
  if (!FLAGS.bloom) on = false;          // ?bloom=0 — the toggle cannot turn it back on
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

/**
 * Rapier's cost in a dense pile climbs faster than the body count, because
 * contact pairs do: measured on this exact workload, 1,200 bodies cost 0.31x
 * of 2,619 rather than the 0.46x a linear model predicts. A phone therefore
 * simulates the nearest 1,200 and lets the rest recede to the same far shell a
 * filtered-out record goes to, so the view stays coherent instead of leaving a
 * frozen grid hanging over the pile.
 */
// A coarse pointer means a phone, where 1,200 bodies is already the ceiling. On a
// desktop the cap exists to bound the collapse, not the steady state — see the
// measurements in README section 7. ?physmax=<n> overrides it for profiling.
const PHYS_MAX = PARAMS.has('physmax')
  ? (parseInt(PARAMS.get('physmax'), 10) || Infinity)
  : (COARSE ? 1200 : Infinity);
let physList = null;

function choosePhysList() {
  const list = activeList();
  if (list.length <= PHYS_MAX) { physList = list; return list; }
  const cam = camera.position;
  const scored = list.map((i) => {
    const a = i * 3;
    const dx = posCur[a] - cam.x, dy = posCur[a + 1] - cam.y, dz = posCur[a + 2] - cam.z;
    return [dx * dx + dy * dy + dz * dz, i];
  });
  scored.sort((p, q) => p[0] - q[0]);
  physList = scored.slice(0, PHYS_MAX).map((p) => p[1]);
  return physList;
}



/**
 * Arrangements were packed to a fixed landscape ratio, which on a phone held
 * upright leaves most of the screen empty and the tiles too small to read.
 * Landscape keeps each arrangement's tuned ratio exactly as before; portrait
 * gets the shape the screen actually has.
 */
function viewAspect(landscape) {
  return innerWidth >= innerHeight ? landscape : Math.max(0.55, innerWidth / innerHeight);
}

/**
 * Matched records fill the arrangement; unmatched ones are pushed out to a
 * shell so the shape you are looking at is always the shape of your query.
 */
function layout(next, instant) {
  if (morphCtl.value < 1) morphCtl.bake();   // never jump: start from where they are
  if (next) mode = next;
  if (mode !== 'physics') stopPhysics();

  const list = activeList();
  // choosePhysList() picks which tiles become bodies and caches it in physList; the
  // physics arrangement then just reads where those tiles already are.
  const { out, labels } = computeLayout(mode, {
    total: N, list, records: DATA.records, viewAspect, posCur,
    physList: mode === 'physics' ? choosePhysList() : null,
  });

  groupLabels.length = 0;
  for (const l of labels) groupLabels.push(l);
  for (let i = 0; i < N; i++) morphCtl.setTarget(i, out[i][0], out[i][1], out[i][2], out[i][3]);

  buildLabels();
  if (!instant) audio.morph();
  if (instant) {
    morphCtl.settle();
  } else {
    morphCtl.upload(!REDUCED);
    morphCtl.start(morphCtl.pickDuration(active, REDUCED));
  }
}

/**
 * Hand the shader a from-state, a to-state and a per-tile delay. Called once per
 * re-arrangement; the interpolation itself then costs the CPU nothing.
 * Tiles that travel furthest are given the smallest delay, so the arrangement
 * empties from its edges and settles inward.
 */

/** Physics owns the positions while it runs: push them straight to the B slot. */

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short hop and a full re-arrangement should not take the same time. */


/**
 * The master clock stays linear and the shader eases each tile inside its own
 * stagger window — easing here as well would compress the wave and read sluggish.
 */

/**
 * Freeze the in-flight interpolation into posCur/quatCur, matching the shader
 * exactly — same per-instance delay, same easing — so a layout change mid-flight
 * starts from where the tiles are actually drawn rather than jumping.
 */

// ------------------------------------------------------------- physics ------
// The pile owns posCur/quatCur while it runs; see web/physics.js. It is built
// lazily because the arrays it writes do not exist until buildScene().
let physics = null;

function makePhysics() {
  return new PhysicsWorld({
    posCur, quatCur, audio,
    onStep: () => morphCtl.flatten(),   // the sim writes positions; morph uploads them
    rng: stream(),
  });
}

/** Enter physics: pick the bodies, show the loading bar if the engine is cold. */
async function startPhysics() {
  if (!FLAGS.physics) return;            // ?physics=0 — refuse before loading the engine
  const list = physList || activeList();
  if (!list.length) return;
  if (!physics) physics = makePhysics();

  if (!PhysicsWorld.loaded) {
    lmsg.textContent = 'loading physics';
    $('#load').classList.remove('gone');
    step(30, 'loading physics engine');
    await PhysicsWorld.load();
    step(100, 'ready');
    setTimeout(() => $('#load').classList.add('gone'), 200);
  }
  await physics.start(list);
  morphCtl.value = 1;
}

function stopPhysics() { if (physics) physics.stop(); }

// --------------------------------------------------------------- picking ----
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2(-9, -9);
let pointerMoved = false, downAt = null;

addEventListener('pointermove', (e) => {
  // Skip the hover path for touch entirely: a drag would otherwise run the
  // 2,619-tile broad phase on every frame of an orbit for a highlight the
  // user cannot see.
  if (e.pointerType === 'touch') return;
  if (!onScene(e)) {                          // over the chrome: drop any hover
    if (hovered >= 0) { hovered = -1; highlight.invalidate(); $('#tip').classList.remove('on'); }
    return;
  }
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerMoved = true;
  const tip = $('#tip');
  if (tip.classList.contains('on')) {
    tip.style.left = Math.min(e.clientX + 16, innerWidth - 310) + 'px';
    tip.style.top = Math.min(e.clientY + 16, innerHeight - 90) + 'px';
  }
});
/** The scene listens on window, so without this a press on the HUD or inside
 *  the detail panel raycasts straight through it and picks the tile behind. */
const onScene = (e) => e.target && e.target.tagName === 'CANVAS';

addEventListener('pointerdown', (e) => {
  if (!onScene(e)) { downAt = null; return; }
  downAt = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
});
addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const slop = downAt.touch ? 12 : 6;          // a finger rolls; a mouse does not
  downAt = null;
  if (moved > slop) return;                    // that was an orbit drag

  // Resolve what is under the point that was *released*, rather than trusting
  // `hovered`. A touch tap fires no pointermove, so `hovered` still holds
  // wherever the pointer was last seen — on a phone that is a different record
  // entirely, and it opens silently with no sign anything went wrong.
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const id = morphCtl.value < 1 ? -1 : pickInstance();
  if (id >= 0) {
    hovered = id; highlight.invalidate();
    selectIndex(id);
  } else if (physics?.ready) {                 // empty space in physics mode: shove
    ray.setFromCamera(ptr, camera);
    const at = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 20), at)) physics.shove(at);
  }
});

/** Visual half-extent of a tile, matching the scale the shader applies. */

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
    const h = highlight.halfSize(i);
    if (Math.abs(_lo.x + _ld.x * t) <= h && Math.abs(_lo.y + _ld.y * t) <= h) return i;
  }
  return -1;
}

function pick() {
  if (COARSE) return;                          // no hover to compute
  if (!pointerMoved) return;
  pointerMoved = false;
  // mid-morph the CPU copy of the positions is the start of the flight, not
  // where the tiles are drawn, so a hover then lands on the wrong tile
  const id = morphCtl.value < 1 ? -1 : pickInstance();
  if (id === hovered) return;
  hovered = id;
  highlight.invalidate();
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
  highlight.invalidate();
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
  // One history entry for the panel, not one per record: on a phone the panel
  // is a full-screen takeover and Back is how you expect to leave it, but
  // stepping back through forty records to exit is not what anyone means.
  if (pushedDetail) history.replaceState(null, '', '#' + r.id);
  else { history.pushState({ atlas: 1 }, '', '#' + r.id); pushedDetail = true; }
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
  const src = physics?.ready ? posCur : posTo;   // the sim owns positions in physics mode
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

let pushedDetail = false;

function closeDetail(fromPop) {
  selected = -1;
  highlight.invalidate();
  $('#detail').classList.remove('open');
  if (!fromPop && pushedDetail) { pushedDetail = false; history.back(); return; }
  pushedDetail = false;
  history.replaceState(null, '', location.pathname + location.search);
}
addEventListener('popstate', () => {
  if (pushedDetail || $('#detail').classList.contains('open')) closeDetail(true);
});

/**
 * Swipe the panel away. On a phone it covers the whole screen, so a single
 * 44px X in the corner was the only way out of it.
 */
function wireDetailSwipe() {
  const el = $('#detail');
  let sx = 0, sy = 0, live = false, axis = 0;      // axis: 0 undecided, 1 swipe, -1 scroll
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    sx = e.clientX; sy = e.clientY; live = true; axis = 0;
  });
  el.addEventListener('pointermove', (e) => {
    if (!live) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // a mostly-vertical drag is the prompt text being scrolled, not a dismiss
      axis = Math.abs(dx) > Math.abs(dy) ? 1 : -1;
      if (axis === 1) el.style.transition = 'none';
    }
    if (axis === 1) el.style.transform = `translateX(${Math.max(0, dx)}px)`;
  });
  const release = (e) => {
    if (!live) return;
    live = false;
    el.style.transition = ''; el.style.transform = '';
    if (axis === 1 && e.clientX - sx > 60) closeDetail();
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
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
        physFrameTimer = setTimeout(() => { if (physics?.ready) frameCamera(elevated); }, 2600);
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
  if (SMALL) $('#q').placeholder = 'Search prompts\u2026';   // the long one truncates

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
  $('#dclose').onclick = () => closeDetail();
  wireDetailSwipe();
  $('#dcopy').onclick = copyPrompt;
  $('#dsimilar').onclick = showSimilar;

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDetail(); $('#q').blur(); }
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
  });
  // Mobile browsers fire resize every time the URL bar slides in or out, so
  // debounce it: reallocating the swapchain mid-scroll is the one thing here
  // that reliably stutters.
  addEventListener('resize', debounce(() => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
  }, 140));
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
  if (detail) detail.releaseInactive(active);
  highlight.stageSweep(posCur, controls.target);
  highlight.invalidate();
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
const _camPrev = new THREE.Vector3();

function tick() {
  const now = performance.now();
  const raw = (now - last) / 1000;      // real elapsed, for the meter
  const dt = Math.min(0.05, raw);       // clamped, so a stall cannot jump the sim
  last = now;

  pick();

  if (detail) detail.stepFade(dt);

  highlight.step(dt, { active, hovered, selected });

  if (physics?.ready) physics.step();

  // re-elect cache holders a few times a second; walking every record and
  // re-uploading the cache texture is not worth doing per frame
  if (detail) detail.tick(dt, camera, posCur, active, morphCtl.value >= 1);

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
    const a = physics?.ready ? 0 : morphCtl.value;
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
    const held = detail ? detail.stats.held : 0;
    $('#fps').textContent = `${fps} fps · ${N.toLocaleString()} tiles · 1 draw call` +
      (detail ? ` · ${held}/${detail.slots} full-res` : '') +
      (physics?.ready ? ` · ${physics.count.toLocaleString()} rigid bodies` : '');
    fpsAcc = 0; fpsN = 0;
  }
}

addEventListener('hashchange', () => {
  if (location.hash.length > 1) selectById(location.hash.slice(1));
});

boot();
