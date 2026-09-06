import * as THREE from 'three';
import { animate, createSpring } from 'animejs';

/**
 * Moving the camera somewhere, and working out where somewhere is.
 *
 * Two jobs that look like one. `fitDistance` is pure trigonometry — how far back a
 * box has to be seen from — and `CameraFlight` is the animation that gets there.
 * They are separable and the fit is the half worth testing, since a wrong fit crops
 * an arrangement and reads as a design decision rather than a bug.
 *
 * The flight arcs rather than cutting a straight line: the view direction is slerped
 * and the distance lerped, so the camera swings around the subject instead of
 * ploughing through it. A spring settles it rather than stopping it dead.
 */

/**
 * How far from a box's centre the camera must sit for the box to fit.
 *
 * Fitted against both FOV axes rather than a bounding sphere. A sphere with a fudge
 * factor is fine for the sphere arrangement and crops the helix top and bottom and
 * the towers at the sides, because neither is remotely spherical.
 *
 * The depth term matters as much as the extents: what has to fit is the near face of
 * the box, not its centre, so half the depth is added back.
 */
export function fitDistance(size, fov, aspect, margin = 1.06) {
  const tanV = Math.tan((fov * Math.PI / 180) / 2);
  const tanH = tanV * aspect;
  const depth = size.z * 0.5;
  return Math.max(6,
    (size.y * 0.5) / tanV + depth,
    (size.x * 0.5) / tanH + depth) * margin;
}

/**
 * How far from a sphere's centre the camera must sit to frame it cleanly without clipping.
 * Uses the perspective tangent cone rather than cuboid depth padding.
 */
export function fitSphereDistance(radius, fov, aspect, margin = 1.08) {
  const halfFovV = (fov * Math.PI / 180) / 2;
  const tanH = Math.tan(halfFovV) * aspect;
  const halfFovH = Math.atan(tanH);
  const minHalfFov = Math.min(halfFovV, halfFovH);
  return Math.max(6, (radius / Math.sin(minHalfFov)) * margin);
}


export class CameraFlight {
  /**
   * @param camera
   * @param controls  OrbitControls; its target is flown too, not just the position
   * @param reduced   honour prefers-reduced-motion: land in 1 ms, linear
   */
  constructor({ camera, controls, reduced = false }) {
    this.camera = camera;
    this.controls = controls;
    this.reduced = reduced;
    this.fly = null;
    this.anim = null;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  get active() { return this.fly !== null; }

  /** Weighted camera move: a spring settles instead of stopping dead. */
  to(fromT, toT, fromP, toP) {
    if (this.anim) this.anim.pause();
    const fromDir = fromP.clone().sub(fromT);
    const toDir = toP.clone().sub(toT);
    const fromR = fromDir.length() || 0.001, toR = toDir.length() || 0.001;
    fromDir.divideScalar(fromR); toDir.divideScalar(toR);
    const box = { t: 0 };
    this.fly = { box, fromT, toT, fromDir, fromR, toR,
                 turn: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir) };
    this.anim = animate(box, {
      t: 1,
      duration: this.reduced ? 1 : 1000,
      ease: this.reduced ? 'linear'
                         : createSpring({ stiffness: 92, damping: 19, mass: 1.1 }),
      onComplete: () => {
        // Land it here rather than trusting the frame loop to have applied t = 1.
        // Under prefers-reduced-motion the duration is 1 ms, so the animation finishes
        // before a single frame runs: `fly` is nulled, apply() never sees it, and the
        // camera never moves at all. Framing did nothing whatsoever for anyone with
        // reduced motion enabled — measured, camera unchanged at (0, 8, 96) where a
        // normal run moves to (0, 10.65, 127.96).
        this.controls.target.copy(toT);
        this.camera.position.copy(toP);
        this.fly = null; this.anim = null;
      },
    });
  }

  /** Fly to a point, keeping the current viewing direction, `back` units away. */
  toPoint(target, back = 9) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.to(this.controls.target.clone(), target.clone(),
            this.camera.position.clone(), target.clone().add(dir.multiplyScalar(back)));
  }

  /**
   * Advance the flight. Called once per frame; a no-op when nothing is in flight.
   *
   * Arc around the target rather than cutting a straight line through the scene:
   * slerp the view direction, lerp the distance.
   */
  apply() {
    const f = this.fly;
    if (!f) return;
    const e = f.box.t;
    this.controls.target.lerpVectors(f.fromT, f.toT, e);
    this._q.identity().slerp(f.turn, e);
    this._v.copy(f.fromDir).applyQuaternion(this._q)
        .multiplyScalar(f.fromR + (f.toR - f.fromR) * e);
    this.camera.position.copy(this.controls.target).add(this._v);
  }

  /**
   * Abandon whatever is in flight, leaving the camera where it stands.
   *
   * A flight outranks anything assigned to camera.position, because apply() rewrites
   * it every frame until the animation ends. Anything that wants to place the camera
   * itself has to cancel first — which is why __atlas.park() begins here.
   */
  cancel() {
    if (this.anim) { this.anim.pause(); this.anim = null; }
    this.fly = null;
  }
}
