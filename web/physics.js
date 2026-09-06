/**
 * The rigid-body pile.
 *
 * OWNERSHIP. While this is running it owns `posCur` and `quatCur` outright: every
 * step overwrites both from the solver, and anything else writing them is writing
 * into a buffer that will be flattened on the very next frame. That is the whole
 * reason this is a module rather than a handful of functions sharing app scope —
 * the boundary is now something you have to cross deliberately.
 *
 * What it does NOT own is the per-instance attribute buffers. It hands positions
 * back through the `onStep` callback and lets the caller decide how they reach the
 * GPU, because `aToPos.w` and `aMeta` belong to the detail cache at the same time
 * and a system that grabbed the whole buffer would corrupt it.
 *
 * The engine is a ~3 MB wasm bundle, so it is fetched on first use, not at boot.
 */

/** Rapier ships a SIMD build worth using where the feature exists. */
function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

// Measured, not guessed: with the threshold at zero, 9 s of a collapsing pile
// produced 681 contact events spanning 0 to 2.4 N — these tiles are thin and
// light. 0.9 keeps the ~20% that read as real knocks; 2.5 maps the hardest of
// them to full loudness.
const CONTACT_THRESHOLD = 0.9;
const IMPACT_SCALE = 2.5;

const FLOOR = -26, WALL = 78;

let RAPIER = null;

export class PhysicsWorld {
  /**
   * @param posCur  Float32Array, 3 per tile — written every step while running
   * @param quatCur Float32Array, 4 per tile — written every step while running
   * @param onStep  called after each step, once posCur/quatCur are current
   * @param rng     () => number in [0,1). A seeded stream makes the pile
   *                reproducible; Math.random does not. See ?seed in app.js.
   * @param audio   optional, for contact sounds
   */
  constructor({ posCur, quatCur, onStep, rng = Math.random, audio = null }) {
    this.posCur = posCur;
    this.quatCur = quatCur;
    this.onStep = onStep;
    this.rng = rng;
    this.audio = audio;
    this.world = null;
    this.bodies = null;
    this.ground = null;
    this.events = null;
    this.ready = false;
  }

  /** How many bodies are in the pile; 0 when it is not running. */
  get count() { return this.bodies ? this.bodies.size : 0; }

  /** True once the engine is in memory, so a caller can skip its loading UI. */
  static get loaded() { return RAPIER !== null; }

  /** Fetch and initialise the engine. Idempotent, and safe to await twice. */
  static async load() {
    if (RAPIER) return RAPIER;
    const url = simdSupported() ? './vendor/rapier-simd.mjs' : './vendor/rapier-plain.mjs';
    RAPIER = (await import(url)).default;
    await RAPIER.init();
    return RAPIER;
  }

  /**
   * Build a world holding `list`, each body starting where its tile currently is.
   * Replaces any world already running.
   */
  async start(list) {
    if (!list || !list.length) return false;
    await PhysicsWorld.load();
    this.stop();

    const { posCur, rng } = this;
    this.world = new RAPIER.World({ x: 0, y: -24, z: 0 });
    // Contact-force events with a threshold, not raw collision events: a 2,619
    // body pile generates thousands of touches a frame, and only the hard ones
    // are worth hearing.
    this.events = new RAPIER.EventQueue(true);

    this.ground = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR - 1, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(WALL, 1, WALL), this.ground);
    for (const [x, z, hx, hz] of
         [[WALL, 0, 1, WALL], [-WALL, 0, 1, WALL], [0, WALL, WALL, 1], [0, -WALL, WALL, 1]]) {
      const b = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(x, FLOOR + 30, z));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 32, hz), b);
    }

    this.bodies = new Map();
    for (const i of list) {
      const a = i * 3;
      const rb = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(posCur[a], Math.max(posCur[a + 1], FLOOR + 3), posCur[a + 2])
          .setLinearDamping(0.16).setAngularDamping(0.28));
      const col = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.05).setRestitution(0.22).setFriction(0.85)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(CONTACT_THRESHOLD);
      this.world.createCollider(col, rb);
      rb.setAngvel({ x: (rng() - .5) * 2, y: (rng() - .5) * 2, z: (rng() - .5) * 2 }, true);
      this.bodies.set(i, rb);
    }
    this.ready = true;
    return true;
  }

  stop() {
    if (this.world) { this.world.free(); this.world = null; }
    if (this.events) { this.events.free(); this.events = null; }
    this.bodies = null;
    this.ground = null;
    this.ready = false;
  }

  /** One solver step, then copy the result back out. */
  step() {
    if (!this.ready) return;
    const { world, events, bodies, posCur, quatCur, audio } = this;
    world.step(events);

    if (audio && audio.on) {
      let heard = 0;
      events.drainContactForceEvents((e) => {
        if (heard++ > 4) return;                       // the voice cap does the rest
        // Where the knock happened, so it arrives from that side of the pile. The
        // collider's own translation is close enough — the contact point is within
        // half a tile of it, and half a tile is nothing at these distances.
        let at = null;
        if (world.getCollider) {
          const c = world.getCollider(e.collider1());
          if (c) at = c.translation();
        }
        const mag = Math.min(1, e.totalForceMagnitude() / IMPACT_SCALE);
        if (at) audio.impact(mag, at.x, at.y, at.z);
        else audio.impact(mag);
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
    this.onStep();
  }

  /** Radial shove — the pile is meant to be disturbed. */
  shove(center, strength = 110, radius = 26) {
    if (!this.ready) return;
    for (const rb of this.bodies.values()) {
      const t = rb.translation();
      const dx = t.x - center.x, dy = t.y - center.y, dz = t.z - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) continue;
      const d = Math.sqrt(d2) || 0.001;
      const f = strength * (1 - d / radius) / d;
      rb.applyImpulse({ x: dx * f, y: dy * f + strength * 0.22, z: dz * f }, true);
    }
  }
}
