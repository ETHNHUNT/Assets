/**
 * Procedural audio for the atlas.
 *
 * Everything here is synthesised at runtime — no sample files, so the page stays
 * offline-capable and the repository does not grow. A sample library or Tone.js
 * (~300 KB) would cost more than the five sounds it would provide.
 *
 * Nothing is created until the user asks for sound: browsers suspend an
 * AudioContext constructed outside a gesture, and building the graph eagerly
 * would leave a permanently suspended context behind.
 */

const PENTATONIC = [0, 2, 4, 7, 9];          // major pentatonic — no wrong notes
const ROOT = 174.61;                          // F3

export class AtlasAudio {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.master = null;
    this.bed = null;
    this.lastHover = 0;
    this.impacts = 0;          // impacts started this frame, for voice capping
    this.impactWindow = 0;
  }

  /** Build the graph on first enable. Returns true if sound is now on. */
  async toggle() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this._build();
    }
    this.on = !this.on;
    if (this.on && this.ctx.state === 'suspended') await this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.on ? 0.9 : 0.0, t, 0.12);
    return this.on;
  }

  _build() {
    const ctx = this.ctx;

    // master: gain -> gentle compressor, so a clattering pile cannot clip
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 24;
    comp.ratio.value = 8; comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp).connect(ctx.destination);

    // ---- ambient bed: three detuned voices under a slowly breathing filter ----
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.055;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 420;
    bedFilter.Q.value = 0.7;
    bedGain.connect(bedFilter).connect(this.master);

    for (const [mult, detune, gain] of [[1, -6, 1], [1, 7, 0.8], [1.5, 3, 0.45], [2, -4, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = ROOT * 0.5 * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(bedGain);
      o.start();
    }

    // a very slow LFO on the filter keeps the pad from sitting still
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 160;
    lfo.connect(lfoAmt).connect(bedFilter.frequency);
    lfo.start();

    // air: filtered noise, barely there, gives the silence some texture
    const air = ctx.createBufferSource();
    air.buffer = this._noise(6);
    air.loop = true;
    const airF = ctx.createBiquadFilter();
    airF.type = 'bandpass'; airF.frequency.value = 900; airF.Q.value = 0.4;
    const airG = ctx.createGain(); airG.gain.value = 0.012;
    air.connect(airF).connect(airG).connect(this.master);
    air.start();

    this.bed = { filter: bedFilter, base: 420 };
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;                 // pink-ish: cheap 3-pole filter
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    return buf;
  }

  _note(semitone, octave = 0) {
    return ROOT * Math.pow(2, octave + semitone / 12);
  }

  /** Short blip when the pointer lands on a tile. Pitch tracks prompt length,
   *  so sweeping across the wall plays the shape of the data. */
  hover(record) {
    if (!this.on) return;
    const now = performance.now();
    if (now - this.lastHover < 55) return;             // one per ~55ms while sweeping
    this.lastHover = now;
    const w = record && record.w ? record.w : 0;
    const step = PENTATONIC[Math.min(PENTATONIC.length - 1,
      Math.floor(Math.log2(1 + w) / 12 * PENTATONIC.length))];
    const oct = w > 200 ? 0 : w > 75 ? 1 : 2;
    this._blip(this._note(step, oct), 0.045, 0.16, 'sine');
  }

  /** Two notes a fifth apart when a record is opened. */
  select() {
    if (!this.on) return;
    this._blip(this._note(0, 1), 0.07, 0.30, 'sine');
    setTimeout(() => this._blip(this._note(7, 1), 0.055, 0.36, 'sine'), 85);
  }

  /** Filtered sweep as an arrangement re-forms. */
  morph() {
    if (!this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise(1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.6;
    f.frequency.setValueAtTime(260, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.5);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.95);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.10);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + 1.0);
  }

  /** One tile striking another. `mag` is normalised 0..1 impact strength. */
  impact(mag) {
    if (!this.on) return;
    const now = performance.now();
    if (now - this.impactWindow > 16) { this.impactWindow = now; this.impacts = 0; }
    if (this.impacts >= 5) return;                     // a 2,619-body pile must not fan out
    this.impacts++;

    const ctx = this.ctx, t = ctx.currentTime;
    const m = Math.min(1, Math.max(0.05, mag));
    const src = ctx.createBufferSource();
    src.buffer = this._noise(0.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + m * 2600 + Math.random() * 400;
    f.Q.value = 1.1 + Math.random();
    const g = ctx.createGain();
    const peak = 0.035 + m * 0.16;
    const dur = 0.05 + m * 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /** Open the pad's filter as the camera moves, so motion is audible. */
  motion(speed) {
    if (!this.on || !this.bed) return;
    const target = this.bed.base + Math.min(1, speed) * 900;
    this.bed.filter.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  _blip(freq, gain, dur, type) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
}
