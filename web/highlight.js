/**
 * How lit each tile is, and how much attention it is being given.
 *
 * OWNERSHIP — the last two lanes, and the pair that closes the map in app.js:
 *
 *   aMeta.y   dim   0 filtered out .. 1 lit
 *   aMeta.z   focus 0 .. 1, hover plus selection
 *
 * `aMeta.w` next door belongs to DetailCache and `aMeta.x` is written once at
 * build, so this writes lanes and never the array — the same rule the morph and
 * the cache follow, for the same reason.
 *
 * Two separate ideas share the sweep because they share a buffer and a frame:
 * `dim` answers "is this in the current filter", `focus` answers "is the pointer
 * or the selection on it". They ease at different rates — focus roughly twice as
 * fast as dim — because a hover has to feel immediate while a filter is a wave
 * you should be able to watch cross the scene.
 *
 * IDLE. `settled` is the whole reason this is cheap. Easing 2,936 tiles per frame
 * would be pure waste for a scene that is usually holding still, so the sweep runs
 * only while something is actually moving and stops itself the moment nothing is.
 * Anything that changes a target — a filter, a hover, a selection — has to call
 * invalidate(), or the change simply will not be picked up. That is the one sharp
 * edge in here.
 */
export class Highlight {
  /**
   * @param n       tile count
   * @param aMeta   the instance attribute holding both lanes
   * @param lanes   { dim, focus } lane indices within aMeta
   * @param reduced honour prefers-reduced-motion: no sweep, everything lands at once
   * @param stagger seconds between the first tile of a filter wave and the last
   */
  constructor({ n, aMeta, lanes, reduced = false, stagger = 0.30 }) {
    this.n = n;
    this.aMeta = aMeta;
    this.DIM = lanes.dim;
    this.FOCUS = lanes.focus;
    this.reduced = reduced;
    this.stagger = stagger;

    this.dimNow = new Float32Array(n).fill(1);
    this.focusNow = new Float32Array(n);
    this.settled = false;
    this.delay = null;              // allocated on the first filter change
    this.t = stagger;               // >= the longest delay means "nothing pending"
  }

  /** Something changed a target; resume easing. */
  invalidate() { this.settled = false; }

  /** The drawn half-extent of a tile, which is what picking has to raycast against. */
  halfSize(i) {
    return 0.5 * (1 + this.focusNow[i] * 0.30) * (0.40 + 0.60 * this.dimNow[i]);
  }

  /**
   * Start a filter wave from the centre of the view: nearest tiles change first and
   * the change spreads outward, so a filter reads as something moving through the
   * scene rather than the whole field blinking at once.
   */
  stageSweep(posCur, centre) {
    const { n } = this;
    if (!this.delay || this.delay.length !== n) this.delay = new Float32Array(n);
    if (this.reduced) { this.delay.fill(0); this.t = this.stagger; return; }
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 3;
      const dx = posCur[a] - centre.x, dy = posCur[a + 1] - centre.y, dz = posCur[a + 2] - centre.z;
      const d = dx * dx + dy * dy + dz * dz;
      this.delay[i] = d;
      if (d > maxD) maxD = d;
    }
    maxD = Math.sqrt(maxD) || 1;
    // Clamped strictly below `stagger`, and that bound is load-bearing rather than
    // cosmetic. The furthest tile's delay is exactly `stagger`, and `delay` is a
    // Float32Array, so 0.30 is stored as 0.30000001192 — larger than the float64
    // 0.30 the timer stops at. That one tile then never satisfies `t >= delay[i]`,
    // so its target holds at whatever it was, nothing reports as touched, `settled`
    // latches, and it stays filtered-out forever. It is the tile furthest from the
    // view centre, it happens on roughly two clears in three, and it is why this
    // multiplies by 0.999.
    const cap = this.stagger * 0.999;
    for (let i = 0; i < n; i++) {
      this.delay[i] = Math.min(Math.sqrt(this.delay[i]) / maxD * this.stagger, cap);
    }
    this.t = 0;
  }

  /**
   * Ease every tile toward its target and write the two lanes. Returns early once
   * nothing has moved for a frame; see the note on `settled` above.
   */
  step(dt, { active, hovered, selected, compare = null }) {
    const { n, aMeta, dimNow, focusNow, delay } = this;
    let touched = false;
    if (this.t < this.stagger) { this.t += dt; touched = true; }
    if (!this.settled) {
      for (let i = 0; i < n; i++) {
        // a tile holds its brightness until its own delay has elapsed
        const dTo = !delay || this.t >= delay[i] ? (active[i] ? 1 : 0) : dimNow[i];
        // A compared tile reads like a selected one, because that is what it is —
        // part of the set being looked at, just several at once.
        const fTo = (i === hovered ? 1 : 0) + (i === selected ? 0.7 : 0)
                  + (compare && compare[i] ? 0.7 : 0);
        // Snap the last thousandth. Both of these approach their target asymptotically
        // and the sweep stops once a step falls under 1e-4, so a settled tile lands
        // *near* 1 rather than at it — and exactly how near depends on how many frames
        // happened to elapse. That is invisible to the eye and fatal to a baseline:
        // the hovered scene drifted by up to maxD 7 between runs of identical code.
        const snap = (v, to) => (Math.abs(to - v) < 1e-3 ? to : v);
        const d = snap(dimNow[i] + (dTo - dimNow[i]) * Math.min(1, dt * 6), dTo);
        const fT = Math.min(1, fTo);
        const f = snap(focusNow[i] + (fT - focusNow[i]) * Math.min(1, dt * 10), fT);
        if (Math.abs(d - dimNow[i]) > 1e-4) {
          dimNow[i] = d; aMeta.array[i * 4 + this.DIM] = d; touched = true;
        }
        if (Math.abs(f - focusNow[i]) > 1e-4) {
          focusNow[i] = f; aMeta.array[i * 4 + this.FOCUS] = f; touched = true;
        }
      }
    }
    if (touched) aMeta.needsUpdate = true; else this.settled = true;
  }
}
