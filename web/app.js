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
import { vec4, uniform, pass, mrt, output } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { animate, createSpring } from 'animejs';
import { AtlasAudio } from './audio.js';
import { PhysicsWorld } from './physics.js';
import { MorphController } from './morph.js';
import { computeLayout, FLAT, NO_MODEL_LABEL } from './layouts.js';
import { Picker } from './picking.js';
import { CameraFlight, fitDistance, fitSphereDistance } from './camera.js';
import { tileMaterial } from './material.js';
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

// Read here rather than beside the code that honours it: three separate subsystems ask
// — the morph shortens to nothing, the highlight sweep drops its stagger, and a camera
// flight lands in 1 ms — and it was previously declared several hundred lines below the
// first of them, which works only because nothing reads it before boot() runs.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
      pickNow() { return picker.pick(ptr, camera, { n: N, posCur, quatCur, active, halfSize: (i) => highlight.halfSize(i) }); },

      /**
       * Aim at a normalised device coordinate and pick, the way a pointer would.
       * Together with project() this makes picking checkable without a single pixel:
       * a tile's centre, projected to NDC and then picked, has to come back as that
       * tile. Pure maths on both sides, so the answer is the same on any machine —
       * which a rendered frame is not.
       */
      pickAt(x, y) { ptr.set(x, y); return picker.pick(ptr, camera, { n: N, posCur, quatCur, active, halfSize: (i) => highlight.halfSize(i) }); },

      /**
       * Frame the current arrangement and report when the flight has landed.
       *
       * Framing is the one piece of camera work with a checkable postcondition: after
       * it settles, every visible tile should be inside the frustum. Nothing else
       * asserts that, and a fit that crops the helix looks like a design
       * choice rather than a bug.
       */
      frameAll(dir) { frameCamera(dir); },
      get flying() { return flight.active; },

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
       * Move between two arrangements under the solver, a fixed number of steps in.
       *
       * A transit is the thing to capture now, not a pile. It is caught mid-flight on
       * purpose: `steps` short of settling is where the springs, the momentum and the
       * collisions are all visible at once, and a settled frame would be identical to
       * the plain layout and prove nothing about how it got there.
       *
       * Stepped here rather than from tick() so rAF is out of it — a background tab
       * throttles that to nothing. Reproducible only under ?seed.
       */
      async physics(steps = 90, from = 'grid', to = 'sphere') {
        layout(from, true);                       // a known start, whatever ran before
        await startPhysics();
        if (!physics.ready) return null;
        physics.teleport(morphCtl.posCur, morphCtl.quatCur);
        layout(to);                               // points the springs somewhere else
        for (let k = 0; k < steps; k++) physics.step();
        morphCtl.flatten();
        return { bodies: physics.count, steps, from, to, seeded: FLAGS.seed !== null };
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
        cameraLocked = true;
        controls.autoRotate = false;
        flight.cancel();
        clearTimeout(physFrameTimer);
        controls.enableDamping = false;
        controls.autoRotate = false;
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
      /**
       * Reorder and lay out instantly.
       *
       * The select itself animates — a non-instant layout, which the solver now drives —
       * but a test wants the ordering, not the transit, and a capture taken while 2,936
       * springs are still converging depends on how many frames happened to elapse.
       * That is what made this scene wobble by maxD 4 when every other one sat at 0:
       * it was the only scene reaching a non-instant path. physics-transit covers the
       * motion; this covers the order.
       */
      setSort(k) { sortBy = k; $('#f-sort').value = k; layout(null, true); },
      /** The order tiles were laid out in, which is the thing a sort has to change. */
      order() { return activeList(); },
      /** The cluster labels and what each one isolates, for a test to drive. */
      labels() {
        return (labelGroup ? labelGroup.children : []).map((m) => ({
          text: m.userData.key, key: m.userData.key, count: m.userData.count,
          pos: [m.position.x, m.position.y, m.position.z],
        }));
      },
      isolate(key) { isolateModel(key); return $('#count').textContent; },
      /** Step the open record through the filtered set, as the arrows do. */
      step(delta) { stepDetail(delta); return $('#dpos').textContent; },
      get nav() {
        return { pos: $('#dpos').textContent,
                 prevDisabled: $('#dprev').disabled, nextDisabled: $('#dnext').disabled };
      },
      wordCounts(ids) { return ids.map((i) => DATA.records[i].w || 0); },
      hover(i) { hovered = i; highlight.invalidate(); },
      clearHighlight() { hovered = -1; selected = -1; sortBy = '';
        $('#q').value = ''; applyFilters(); },

      /**
       * Open and close the detail panel the way a click and Escape do.
       *
       * The panel carries an invariant a test can hold it to and a reader cannot see:
       * selecting forty records in a row must leave one history entry, not forty,
       * because Back is how the panel is dismissed on a phone and stepping back
       * through the whole session is not what anyone means by that.
       */
      select(i) { selectIndex(i); },
      closePanel() { closeDetail(); },
      get panel() {
        return {
          open: $('#detail').classList.contains('open'),
          selected,
          name: $('#dname').textContent,
          prompt: $('#dprompt').textContent,
          rid: $('#drid').textContent,
          tags: $('#dtags').children.length,
          copyShown: $('#dcopy').style.display !== 'none',
          hash: location.hash,
        };
      },
      get flags() { return { ...FLAGS }; },
      get counts() { return { instances: N, active: active.reduce((a, v) => a + v, 0) }; },
    };
    step(100, 'ready');
    setTimeout(() => $('#load').classList.add('gone'), 260);
    // Not awaited: the morph carries motion until the solver is up, then it takes over.
    startPhysics();
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
  flight = new CameraFlight({ camera, controls, reduced: REDUCED });
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

  mesh = new THREE.InstancedMesh(geo,
    tileMaterial({ atlas: ATLAS, perRow: PER_ROW, detail, uMorph }), N);
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
    // What clicking it means. Null for the rolled-up tail, which names no model.
    m.userData.key = L.key || null;
    m.userData.count = L.count;
    labelGroup.add(m);
  }
  labelGroup.renderOrder = 2;
  scene.add(labelGroup);
}

/**
 * The model filter's stand-in for "attributed to no model at all".
 *
 * 514 records carry no model, which is a set worth being able to ask for — the
 * clusters view already gives it a labelled block. An empty string cannot say it,
 * because that is what the filter uses for "any model", so it needs a value of its
 * own that no real model will ever collide with.
 */
const NO_MODEL = '\u0000none';

const MODES = {
  grid: 'Grid', sphere: 'Sphere', helix: 'Helix',
  clusters: 'By model',
};

/** Indices that currently pass the filters, in atlas order. */
/**
 * How tiles are ordered within an arrangement.
 *
 * There was always an order — the build sorts by tool type then model — but it was
 * fixed and invisible, which for a 2,936-item reference library reads the same as no
 * order at all. You cannot scan a wall you cannot predict.
 *
 * Name is deliberately absent: `n` is populated on 764 of 2,936 records, so sorting
 * by it would leave three quarters of the atlas in an arbitrary tail. Nor is there a
 * date to sort by; the records carry no timestamp.
 *
 * Every comparator ends in `a - b` so ties keep atlas order and the result is total —
 * an unstable ordering would make the same filter lay out differently between runs.
 */
const SORTS = {
  '': null,                                   // atlas order: tool, then model
  // Presets publish no prompt at all, so `w` is absent on 538 records. Zero is the
  // honest reading of that rather than a missing value to shuffle to the end: they
  // genuinely have no words, and they belong at the short end where you would look.
  length: (a, b) => (DATA.records[a].w || 0) - (DATA.records[b].w || 0) || a - b,
  model: (a, b) => cmpText(DATA.records[a].m, DATA.records[b].m) || a - b,
  tool: (a, b) => cmpText(DATA.records[a].t, DATA.records[b].t) || a - b,
};

/** Blank last rather than first: an unattributed record is not the letter A. */
function cmpText(x, y) {
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return x.localeCompare(y);
}

let sortBy = '';

function activeList() {
  const a = [];
  for (let i = 0; i < N; i++) if (active[i]) a.push(i);
  const cmp = SORTS[sortBy];
  return cmp ? a.sort(cmp) : a;
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

  const list = activeList();
  const { out, labels } = computeLayout(mode, {
    total: N, list, records: DATA.records, viewAspect, posCur,
  });

  groupLabels.length = 0;
  for (const l of labels) groupLabels.push(l);
  for (let i = 0; i < N; i++) morphCtl.setTarget(i, out[i][0], out[i][1], out[i][2], out[i][3]);

  buildLabels();
  if (!instant) audio.morph();

  // Once the solver is up it owns the motion, for every arrangement rather than for
  // one of them. Changing layout just points the springs somewhere else, so tiles
  // accelerate, carry momentum and shoulder past each other on the way — which is
  // the whole reason to have a solver in a thing like this.
  //
  // The morph still runs before Rapier finishes loading, and for instant moves that
  // a test or a filter asks for. It is the fallback now, not the mechanism.
  if (physics?.ready && !instant) {
    physics.setTargets(morphCtl.posTo, morphCtl.quatTo);
    return;
  }
  if (instant) {
    morphCtl.settle();
    if (physics?.ready) physics.teleport(morphCtl.posCur, morphCtl.quatCur);
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

/**
 * Bring the solver up in the background.
 *
 * Rapier is a ~3 MB wasm bundle and motion is not worth delaying first paint for, so
 * this is deliberately not awaited at boot: the morph carries the first few seconds
 * and the solver takes over the moment it is ready. Nobody sees a loading bar for it.
 */
let physicsBoot = null;

function startPhysics() {
  if (!FLAGS.physics) return Promise.resolve();   // ?physics=0 — never load the engine
  // One boot, shared. Called from boot() without awaiting and again from a test, and
  // two concurrent start()s meant the second freeing a world the first was still
  // building — a wasm double free, thrown from inside Rapier where the cause is
  // invisible. Handing every caller the same promise makes the second call a no-op.
  if (physicsBoot) return physicsBoot;
  physicsBoot = (async () => {
    const list = physList || activeList();
    if (!list.length) return;
    if (!physics) physics = makePhysics();
    await PhysicsWorld.load();
    await physics.start(list);
    physics.teleport(morphCtl.posCur, morphCtl.quatCur);
    physics.setTargets(morphCtl.posTo, morphCtl.quatTo);
    morphCtl.value = 1;
  })();
  return physicsBoot;
}

function stopPhysics() { if (physics) physics.stop(); }

// --------------------------------------------------------------- picking ----
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

/**
 * The label under the pointer, or null.
 *
 * A separate raycast from the tile pick, and cheap enough not to care: there are at
 * most thirteen labels against 2,936 tiles, and they are ordinary meshes rather than
 * instances, so three's own intersectObjects is the right tool here where it is
 * exactly the wrong one for the atlas.
 */
function pickLabel() {
  if (!labelGroup) return null;
  const r = picker.rayAt(ptr, camera);
  const hit = r.intersectObjects(labelGroup.children, false)[0];
  return hit && hit.object.userData.key ? hit.object.userData.key : null;
}

/**
 * Clicking a cluster label isolates that model.
 *
 * The labels read as analysis — "By model", with counts — but until now they were
 * captions on a poster. A heading that tells you a model holds 1,338 records and
 * cannot show you them is describing the work rather than doing it.
 */
function isolateModel(key) {
  $('#q').value = '';
  // The block for unattributed records is labelled in words; the filter needs the
  // sentinel. Without the swap the select silently falls back to "All models" and
  // clicking a label that promises 514 records hands you all 2,936.
  $('#f-model').value = key === NO_MODEL_LABEL ? NO_MODEL : key;
  $('#f-tool').value = ''; $('#f-style').value = ''; $('#f-kind').value = '';
  applyFilters();
  frameCamera();
}

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
  // Labels first: one sits in front of the block it names, so testing tiles first
  // would hand every label click to whatever tile happens to be behind it.
  const label = pickLabel();
  if (label) { isolateModel(label); return; }
  const id = morphCtl.value < 1 ? -1 : picker.pick(ptr, camera, { n: N, posCur, quatCur, active, halfSize: (i) => highlight.halfSize(i) });
  if (id >= 0) {
    hovered = id; highlight.invalidate();
    selectIndex(id);
  } else if (physics?.ready) {                 // empty space in physics mode: shove
    const r = picker.rayAt(ptr, camera);
    const at = new THREE.Vector3();
    if (r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 20), at)) physics.shove(at);
  }
});

/** Visual half-extent of a tile, matching the scale the shader applies. */


const picker = new Picker();

function pick() {
  if (COARSE) return;                          // no hover to compute
  if (!pointerMoved) return;
  pointerMoved = false;
  // mid-morph the CPU copy of the positions is the start of the flight, not
  // where the tiles are drawn, so a hover then lands on the wrong tile
  const id = morphCtl.value < 1 ? -1 : picker.pick(ptr, camera, { n: N, posCur, quatCur, active, halfSize: (i) => highlight.halfSize(i) });
  if (id === hovered) return;
  hovered = id;
  highlight.invalidate();
  const tip = $('#tip');
  if (id < 0) {
    tip.classList.remove('on');
    // a label is still something to click, so keep the cursor honest over one
    document.body.style.cursor = pickLabel() ? 'pointer' : '';
    return;
  }
  const r = DATA.records[id];
  audio.hover(r, posCur[id * 3], posCur[id * 3 + 1], posCur[id * 3 + 2]);
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
  // Tags that filter. A pill naming a model you cannot click is decoration; the same
  // argument as the cluster labels, and the same fix. Only the three that map onto a
  // filter carry a target — style and subject pills stay inert rather than pretending.
  const tags = [];
  const pill = (text, kind, value) =>
    `<span class="t${kind === 'model' ? ' m' : ''}"` +
    (value ? ` data-f="${kind}" data-v="${esc(value)}"` : '') + `>${esc(text)}</span>`;
  if (r.m) tags.push(pill(r.m, 'model', r.m));
  if (r.t) tags.push(pill(r.t, 'tool', r.t));
  r.s.slice(0, 3).forEach((x) => tags.push(pill(x, 'style', x)));
  r.v.slice(0, 2).forEach((x) => tags.push(pill(x, '', null)));
  if (r.k) tags.push(pill(r.k, '', null));
  if (r.g) tags.push(pill(r.g, '', null));
  $('#dtags').innerHTML = tags.join('');
  updateDetailNav();
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
  flight.toPoint(new THREE.Vector3(posCur[i * 3], posCur[i * 3 + 1], posCur[i * 3 + 2]));
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
  const dist = mode === 'sphere'
    ? fitSphereDistance(size.x * 0.5, camera.fov, camera.aspect)
    : fitDistance(size, camera.fov, camera.aspect);
  const dir0 = preferDir ? preferDir.clone().normalize()
                         : camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir0.x) || dir0.lengthSq() < 1e-6) dir0.set(0, 0.18, 1).normalize();
  const dir = dir0;
  // keep the subject clear of the detail panel when it is open
  const toP = centre.clone().add(dir.multiplyScalar(dist));
  const toT = centre.clone();
  if ($('#detail').classList.contains('open') && innerWidth > 820) {
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const shift = right.multiplyScalar(dist * 0.16);
    toP.add(shift); toT.add(shift);
  } else if (mode === 'sphere' && innerWidth > 820) {
    // on desktop, balance the left sidebar so the sphere is visually centered in the open canvas
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const shift = right.multiplyScalar(dist * 0.04);
    toP.add(shift); toT.add(shift);
  }
  flight.to(controls.target.clone(), toT, camera.position.clone(), toP);
}

let flight = null;                       // CameraFlight; see web/camera.js
let physFrameTimer = 0;
// Set once a test places the camera by hand. Nothing may move it after that — not a
// flight, not idle rotation — or a captured frame stops being reproducible.
let cameraLocked = false;
const _fwd = new THREE.Vector3();   // scratch for the audio listener's facing


let pushedDetail = false;

/**
 * Where the open record sits in the set you are working, and whether there is more.
 *
 * The panel used to be a dead end: open a tile and the only way on was back out to
 * the scene and finding the next one by eye. Stepping is over the filtered set in
 * laid-out order, so it agrees with what is on screen and with whatever sort is
 * active rather than with the order the records happen to be stored in.
 */
function updateDetailNav() {
  const list = activeList();
  const at = list.indexOf(selected);
  $('#dpos').textContent = at < 0 ? '' : `${at + 1} of ${list.length.toLocaleString()}`;
  $('#dprev').disabled = at <= 0;
  $('#dnext').disabled = at < 0 || at >= list.length - 1;
}

/** Step to the next or previous record in the set currently on screen. */
function stepDetail(delta) {
  const list = activeList();
  const at = list.indexOf(selected);
  if (at < 0) return;
  const next = at + delta;
  if (next < 0 || next >= list.length) return;
  selectIndex(list[next]);
}

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
      layout(k);
      frameCamera(k === 'clusters' ? new THREE.Vector3(0, 0.13, 1) : undefined);
    };
    modes.appendChild(b);
  }

  const uniq = (fn) => [...new Set(DATA.records.flatMap(fn).filter(Boolean))].sort();
  fill('#f-tool', uniq((r) => [r.t]));
  fill('#f-model', uniq((r) => [r.m]), [[NO_MODEL, 'No model attributed']]);
  fill('#f-style', uniq((r) => r.s));
  function fill(sel, vals, extra = []) {
    const el = $(sel);
    for (const [v, label] of [...extra, ...vals.map((v) => [v, v])]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label; el.appendChild(o);
    }
    el.onchange = applyFilters;
  }
  $('#f-kind').onchange = applyFilters;
  $('#f-sort').onchange = () => { sortBy = $('#f-sort').value; layout(null); };

  $('#dprev').onclick = () => stepDetail(-1);
  $('#dnext').onclick = () => stepDetail(1);

  // Delegated, because the pills are rewritten on every selection.
  $('#dtags').onclick = (e) => {
    const t = e.target.closest('[data-f]');
    if (!t) return;
    const kind = t.dataset.f, value = t.dataset.v;
    $('#q').value = '';
    if (kind === 'model') $('#f-model').value = value === NO_MODEL_LABEL ? NO_MODEL : value;
    if (kind === 'tool') $('#f-tool').value = value;
    if (kind === 'style') $('#f-style').value = value;
    applyFilters();
    frameCamera();
  };
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
    if ($('#detail').classList.contains('open') && document.activeElement !== $('#q')) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepDetail(1); }
    }
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if ((e.key === 'i' || e.key === 'I') && document.activeElement !== $('#q')) {
      if (mode === 'sphere') {
        const inside = camera.position.distanceTo(controls.target) < 14;
        if (inside) {
          frameCamera();
        } else {
          const dir = camera.position.clone().sub(controls.target).normalize();
          flight.to(controls.target.clone(), controls.target.clone().sub(dir.clone().multiplyScalar(22)),
                    camera.position.clone(), controls.target.clone().add(dir.clone().multiplyScalar(3.2)));
        }
      }
    }
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
    const modelOk = !model || (model === NO_MODEL ? !r.m : r.m === model);
    const ok = (!tool || r.t === tool) && modelOk &&
               (!style || r.s.includes(style)) && (!kind || r.k === kind) &&
               (!q || r.p.toLowerCase().includes(q) || r.n.toLowerCase().includes(q) ||
                     r.m.toLowerCase().includes(q));
    active[i] = ok ? 1 : 0;
    if (ok) n++;
  }
  if (detail) detail.releaseInactive(active);
  highlight.stageSweep(posCur, controls.target);
  highlight.invalidate();
  if ($('#detail').classList.contains('open')) updateDetailNav();
  $('#count').textContent = `${n.toLocaleString()} of ${N.toLocaleString()}`;
  $('#empty').classList.toggle('on', n === 0);
  const wasNarrow = lastCount <= N * 0.25, isNarrow = n <= N * 0.25;
  lastCount = n;
  layout(null);
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

  flight.apply();

  if (labelGroup) {
    const a = physics?.ready ? 0 : morphCtl.value;
    labelGroup.visible = a > 0.05;
    labelGroup.children.forEach((m) => {
      m.material.opacity = a;
      m.quaternion.copy(camera.quaternion);
    });
  }
  if (audio.on) {
    // Keep the ear on the camera. Cheap, and it has to happen every frame or the
    // soundstage lags a flight.
    camera.getWorldDirection(_fwd);
    audio.setListener(camera.position.x, camera.position.y, camera.position.z,
                      _fwd.x, _fwd.y, _fwd.z,
                      camera.up.x, camera.up.y, camera.up.z);
    const d = camera.position.distanceTo(_camPrev);
    _camPrev.copy(camera.position);
    audio.motion(d / Math.max(dt, 1e-3) / 40);
  }
  if (dust) dust.rotation.y += dt * 0.006;
  // `cameraLocked`, not `controls.enableDamping`. Both are false after a park() and
  // the harness passed either way, but only one of them says what is meant: damping
  // being off happened to be a side effect of parking, so the determinism of every
  // sphere baseline rested on park() continuing to disable it. Anyone tidying that
  // line would have made the baselines quietly irreproducible, with the sphere
  // drifting a fraction of a degree between capture and check and no clue why.
  const allowAutoRotate = !cameraLocked && mode === 'sphere'
    && hovered < 0 && selected < 0 && !flight.active;
  if (controls.autoRotate !== allowAutoRotate) {
    controls.autoRotate = allowAutoRotate;
    controls.autoRotateSpeed = 0.35;
  }
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
