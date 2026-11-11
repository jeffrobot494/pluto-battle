import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface TwistSettings {
  /** Degrees two fingers must twist before the camera starts turning, so pinches don't rotate. */
  twistThreshold: number;
  /** Seconds for a released spin to slow to about a third of its speed; zero stops dead. */
  twistCoast: number;
}

/** Signed shortest turn from angle `from` to angle `to`, in radians within [-π, π]. */
export function angleDelta(from: number, to: number) {
  const d = to - from;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/** Angle of the line from the first to the second touch, in screen space (y down, so positive turns clockwise). */
function touchAngle(a: { x: number; y: number }, b: { x: number; y: number }) { return Math.atan2(b.y - a.y, b.x - a.x); }

/** Released spins slower than this (rad/s) stop. */
const MIN_COAST_SPEED = 0.02;
/** A release this long after the last twist movement counts as holding still, so it doesn't coast. */
const COAST_RELEASE_MS = 80;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Two-finger twist turns the camera around the ground under the fingers, like rotating a map.
 * Runs alongside OrbitControls' two-finger pinch and pan; only touch pointers take part.
 */
export class CameraTwist {
  private readonly events = new AbortController();
  private readonly touches = new Map<number, { x: number; y: number }>();
  private gesture: { angle: number; total: number; engaged: boolean; time: number } | null = null;
  private velocity = 0;
  private readonly pivot = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly ndc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane();
  private lastUpdate = 0;
  /** Live settings; the renderer refreshes these from tuning each frame. */
  settings: TwistSettings = { twistThreshold: 12, twistCoast: 0.4 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls) {
    const options = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch') return;
      // Touching the screen catches a coasting spin, like putting a hand on a turning disc.
      this.velocity = 0;
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.begin();
    }, options);
    canvas.addEventListener('pointermove', event => {
      const touch = this.touches.get(event.pointerId);
      if (!touch) return;
      touch.x = event.clientX; touch.y = event.clientY;
      this.move(event.timeStamp);
    }, options);
    const end = (event: PointerEvent) => {
      if (!this.touches.delete(event.pointerId)) return;
      // Only the lift that ends a twist decides coasting; the other finger lifting later must not cancel it.
      const g = this.gesture;
      if (g && (!g.engaged || event.timeStamp - g.time > COAST_RELEASE_MS)) this.velocity = 0;
      this.begin();
    };
    canvas.addEventListener('pointerup', end, options);
    canvas.addEventListener('pointercancel', end, options);
  }

  /** True while a twist is turning the camera or a released spin is still coasting. */
  get active() { return !!this.gesture?.engaged || this.velocity !== 0; }

  /** Restarts gesture tracking whenever the set of touches changes; only exactly two fingers twist. */
  private begin() {
    if (this.touches.size !== 2) { this.gesture = null; return; }
    const [a, b] = this.touches.values();
    this.gesture = { angle: touchAngle(a, b), total: 0, engaged: false, time: 0 };
    this.velocity = 0;
  }

  private move(time: number) {
    const g = this.gesture;
    if (!g) return;
    const [a, b] = this.touches.values(), angle = touchAngle(a, b), delta = angleDelta(g.angle, angle);
    g.angle = angle;
    if (!g.engaged) {
      g.total += delta;
      // Start turning from here rather than jumping by the whole threshold.
      if (Math.abs(g.total) >= THREE.MathUtils.degToRad(this.settings.twistThreshold)) { g.engaged = true; g.time = time; }
      return;
    }
    this.setPivot((a.x + b.x) / 2, (a.y + b.y) / 2);
    this.rotate(delta);
    const dt = (time - g.time) / 1000;
    // Smoothed angular speed, kept for coasting after release.
    if (dt > 0) this.velocity = THREE.MathUtils.lerp(this.velocity, delta / dt, Math.min(1, dt / 0.05));
    g.time = time;
  }

  /** Ground point under the fingers' midpoint, at the orbit target's height; falls back to the target. */
  private setPivot(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.set(UP, -this.controls.target.y);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.pivot)) this.pivot.copy(this.controls.target);
  }

  /** Orbits camera and target together about a vertical axis through the pivot; positive turns the view clockwise. */
  private rotate(angle: number) {
    for (const point of [this.camera.position, this.controls.target]) {
      this.offset.copy(point).sub(this.pivot).applyAxisAngle(UP, angle);
      point.copy(this.pivot).add(this.offset);
    }
  }

  /** Advances a released spin; call once per frame before `controls.update()`. */
  update(now = performance.now()) {
    const dt = Math.min(0.1, this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0);
    this.lastUpdate = now;
    if (this.gesture || this.velocity === 0 || dt === 0) return;
    if (this.settings.twistCoast <= 0) { this.velocity = 0; return; }
    this.rotate(this.velocity * dt);
    this.velocity *= Math.exp(-dt / this.settings.twistCoast);
    if (Math.abs(this.velocity) < MIN_COAST_SPEED) this.velocity = 0;
  }

  /** Stops any coasting spin and forgets touches in progress. */
  stop() { this.velocity = 0; this.gesture = null; this.touches.clear(); }

  dispose() { this.events.abort(); this.stop(); }
}
