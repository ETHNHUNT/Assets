/**
 * Physics as the way things move, not as a thing to look at.
 *
 * This used to switch gravity on and drop the whole atlas into a pile on a floor.
 * That is a demo of a physics engine; it is not motion. What a solver is actually
 * worth here is the transit between arrangements — tiles that accelerate, carry
 * momentum, shoulder past each other and settle, instead of every tile gliding
 * along its own private eased path oblivious to the 2,935 others.
 *
 * So: no gravity, no floor, no walls. Each body is pulled toward where its
 * arrangement wants it by a critically damped spring, and everything interesting
 * happens on the way — the collisions are the point, not a side effect. Switch
 * arrangement while it runs and the atlas rearranges itself physically.
 *
 * OWNERSHIP is unchanged: while this runs it owns posCur and quatCur outright, and
 * reaches the GPU through MorphController.flatten() rather than touching the
 * instance buffers itself.
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

/**
 * Spring constants, as a frequency and a damping ratio rather than raw k and c,
 * because those are the numbers with meaning: OMEGA is how fast a tile converges
 * (rad/s — 6 settles in about a second) and ZETA is whether it overshoots. 1.0 is
 * critical damping, the fastest approach that does not oscillate; slightly under
 * gives the arrival a little weight without wobble.
 *
 * Torque uses the same idea about the shortest rotation to the target orientation,
 * so a tile knocked askew on the way rights itself rather than staying crooked.
 */
const OMEGA = 6.0, ZETA = 0.9;
const OMEGA_R = 7.0, ZETA_R = 0.9;

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
    this.posTo = null;
    this.quatTo = null;
    this.asleep = false;
    this.events = null;
    this.ready = false;
    this._still = 0;
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
    // Zero gravity. Nothing here is falling; everything is being pulled to where its
    // arrangement wants it, and a floor would only be something to pile up against.
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    // Contact-force events with a threshold, not raw collision events: a 2,619
    // body pile generates thousands of touches a frame, and only the hard ones
    // are worth hearing.
    this.events = new RAPIER.EventQueue(true);

    this.bodies = new Map();
    for (const i of list) {
      const a = i * 3;
      const rb = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(posCur[a], posCur[a + 1], posCur[a + 2])
          .setLinearDamping(0.08).setAngularDamping(0.45));
      const col = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.05).setRestitution(0.22).setFriction(0.85)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(CONTACT_THRESHOLD);
      this.world.createCollider(col, rb);
      // A small seeded spin, so tiles do not move as one rigid slab — but nothing
      // like the tumble a dropped pile wants. The torque below undoes it as they land.
      rb.setAngvel({ x: (rng() - .5) * 0.5, y: (rng() - .5) * 0.5, z: (rng() - .5) * 0.5 }, true);
      this.bodies.set(i, rb);
    }
    this.ready = true;
    return true;
  }

  stop() {
    if (this.world) { this.world.free(); this.world = null; }
    if (this.events) { this.events.free(); this.events = null; }
    this.bodies = null;
    this.ready = false;
  }

  /**
   * Where every body is being pulled to. Called whenever the arrangement changes,
   * which is what makes switching arrangement mid-simulation a physical event rather
   * than a restart: the springs simply start pointing somewhere else.
   */
  setTargets(posTo, quatTo) {
    this.posTo = posTo;
    this.quatTo = quatTo;
    this.asleep = false;
    this._still = 0;
  }

  /**
   * Put every body exactly where the arrangement says, with no velocity.
   *
   * For the moves that are not motion: a filter re-layout, a test parking a scene,
   * anything asking for tiles to simply be somewhere. Without this the solver would
   * still be holding the previous positions and would haul everything back.
   */
  teleport(posCur, quatCur) {
    if (!this.ready) return;
    this.asleep = false;
    this._still = 0;
    const zero = { x: 0, y: 0, z: 0 };
    for (const [i, rb] of this.bodies) {
      const a = i * 3, b = i * 4;
      rb.setTranslation({ x: posCur[a], y: posCur[a + 1], z: posCur[a + 2] }, true);
      rb.setRotation({ x: quatCur[b], y: quatCur[b + 1],
                       z: quatCur[b + 2], w: quatCur[b + 3] }, true);
      rb.setLinvel(zero, true);
      rb.setAngvel(zero, true);
    }
  }

  /**
   * Steer one body toward its target, then let the solver do the rest.
   *
   * Impulses rather than forces, because Rapier keeps a force until it is reset and
   * an impulse is spent on the step it is given to — which is what a per-step
   * controller wants. Both are scaled by mass so a spring behaves the same whatever
   * the collider weighs.
   */
  _steer(i, rb, dt) {
    const { posTo, quatTo } = this;
    const m = rb.mass() || 1;
    const p = rb.translation(), v = rb.linvel(), a = i * 3;

    const k = OMEGA * OMEGA, c = 2 * ZETA * OMEGA;
    rb.applyImpulse({
      x: m * dt * (k * (posTo[a] - p.x) - c * v.x),
      y: m * dt * (k * (posTo[a + 1] - p.y) - c * v.y),
      z: m * dt * (k * (posTo[a + 2] - p.z) - c * v.z),
    }, true);

    // Shortest rotation from where the tile is to where it should be. qErr = qt * qc*,
    // negated when w < 0 so it takes the near way round rather than the long one —
    // without that a tile 179 degrees out spins most of a full turn to get home.
    const q = rb.rotation(), w = rb.angvel(), b = i * 4;
    let ex = quatTo[b] * q.w - quatTo[b + 3] * q.x - quatTo[b + 1] * q.z + quatTo[b + 2] * q.y;
    let ey = quatTo[b + 1] * q.w - quatTo[b + 3] * q.y - quatTo[b + 2] * q.x + quatTo[b] * q.z;
    let ez = quatTo[b + 2] * q.w - quatTo[b + 3] * q.z - quatTo[b] * q.y + quatTo[b + 1] * q.x;
    let ew = quatTo[b + 3] * q.w + quatTo[b] * q.x + quatTo[b + 1] * q.y + quatTo[b + 2] * q.z;
    if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; ew = -ew; }
    // small-angle: the vector part is already half the rotation vector
    const kr = OMEGA_R * OMEGA_R, cr = 2 * ZETA_R * OMEGA_R;
    const I = m * 0.08;                       // a thin quad; exact inertia is not the point
    rb.applyTorqueImpulse({
      x: I * dt * (kr * 2 * ex - cr * w.x),
      y: I * dt * (kr * 2 * ey - cr * w.y),
      z: I * dt * (kr * 2 * ez - cr * w.z),
    }, true);

    return [Math.hypot(posTo[a] - p.x, posTo[a + 1] - p.y, posTo[a + 2] - p.z),
            Math.hypot(v.x, v.y, v.z)];
  }

  /** One solver step, then copy the result back out. */
  step(dt = 1 / 60) {
    if (!this.ready || this.asleep) return;
    const { world, events, bodies, posCur, quatCur, audio } = this;
    let worstD = 0, worstV = 0;
    if (this.posTo && this.quatTo) {
      for (const [i, rb] of bodies) {
        const d = this._steer(i, rb, dt);
        if (d[0] > worstD) worstD = d[0];
        if (d[1] > worstV) worstV = d[1];
      }
    }
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

    // Stop once nothing is moving — and note that is not the same as everything having
    // arrived. In a packed sphere a handful of tiles come to rest against their
    // neighbours a little short of where the arrangement wanted them: measured, 8 of
    // 2,936 sit up to 1.3 units off at a worst speed of 0.04. That is the solver being
    // right rather than wrong, so waiting for distance to reach zero would wait forever.
    //
    // Rapier sleeps bodies left alone, but a steering impulse every step is precisely
    // what stops them being left alone, so a settled atlas went on costing 1.6 ms a
    // frame for as long as the tab was open. Three consecutive still steps, so a
    // momentary zero crossing mid-flight cannot end the motion early.
    if (worstV < 0.05) { if (++this._still >= 3) this.asleep = true; }
    else this._still = 0;
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
