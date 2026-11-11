import { HOLD_DELAY_MS } from './upgrades.ts';

export interface GroundPoint { x: number; y: number; z: number }

export interface BattleInputHandlers {
  /** Ground under a screen point, or null off the battlefield. */
  pick(clientX: number, clientY: number): GroundPoint | null;
  /** A quick press and release without dragging. */
  tap(clientX: number, clientY: number): void;
  /** A still press became a hold on this ground point. */
  holdStart(point: GroundPoint): void;
  /** The hold ended: `commit` is true on release, false when canceled. */
  holdEnd(commit: boolean): void;
  /** Mouse hover with no buttons pressed; null when the pointer leaves or presses. */
  hover(clientX: number, clientY: number): void;
  hoverEnd(): void;
  /** Camera panning is locked while a hold is active so finger drift does not scroll the map. */
  lockPan(locked: boolean): void;
}

/** Pixels a press can drift and still count as a tap or begin a hold. */
const SLOP = 8;

/**
 * Tap and tap-and-hold gestures sharing the canvas with OrbitControls.
 * A drag before the hold begins is left to the camera; a second finger cancels.
 */
export class BattleInput {
  private readonly events = new AbortController();
  private readonly pointers = new Set<number>();
  private gesture: { id: number; x: number; y: number; timer: number; holding: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, private readonly handlers: BattleInputHandlers) {
    const options = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', event => {
      this.pointers.add(event.pointerId);
      this.handlers.hoverEnd();
      if (this.pointers.size > 1) { this.cancel(); return; }
      if (!event.isPrimary || event.button !== 0) return;
      this.cancel();
      this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, holding: false, timer: window.setTimeout(() => this.beginHold(), HOLD_DELAY_MS) };
    }, options);
    canvas.addEventListener('pointermove', event => {
      const g = this.gesture;
      if (g?.id === event.pointerId && !g.holding && Math.hypot(event.clientX - g.x, event.clientY - g.y) > SLOP) this.cancel();
      if (event.pointerType === 'mouse' && this.pointers.size === 0) this.handlers.hover(event.clientX, event.clientY);
    }, options);
    canvas.addEventListener('pointerup', event => {
      const g = this.gesture, own = g?.id === event.pointerId;
      const tap = own && !g.holding && event.button === 0 && this.pointers.size === 1 && Math.hypot(event.clientX - g.x, event.clientY - g.y) <= SLOP;
      this.pointers.delete(event.pointerId);
      if (own) {
        if (g.holding) this.finish(true);
        else { clearTimeout(g.timer); this.gesture = null; }
      }
      if (tap) this.handlers.tap(event.clientX, event.clientY);
    }, options);
    canvas.addEventListener('pointercancel', event => { this.pointers.delete(event.pointerId); this.cancel(); }, options);
    canvas.addEventListener('pointerleave', () => this.handlers.hoverEnd(), options);
    window.addEventListener('blur', () => this.reset(), options);
  }

  get holding() { return !!this.gesture?.holding; }

  private beginHold() {
    const g = this.gesture;
    if (!g || g.holding) return;
    const point = this.handlers.pick(g.x, g.y);
    if (!point) { this.gesture = null; return; }
    g.holding = true; this.handlers.lockPan(true); this.handlers.holdStart(point);
  }
  private finish(commit: boolean) {
    const g = this.gesture; if (!g) return;
    clearTimeout(g.timer); this.gesture = null;
    if (g.holding) { this.handlers.lockPan(false); this.handlers.holdEnd(commit); }
  }
  /** Abandons the current gesture without triggering it. */
  cancel() { this.finish(false); }
  /** Abandons the gesture and forgets pressed pointers. */
  reset() { this.cancel(); this.pointers.clear(); this.handlers.hoverEnd(); }
  dispose() { this.reset(); this.events.abort(); }
}
