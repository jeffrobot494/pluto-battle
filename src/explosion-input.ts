export interface GroundPoint { x: number; y: number; z: number }

/** A tap gesture shares the canvas with OrbitControls without taking over its events. */
export class ExplosionInput {
  private enabled = false;
  private readonly events = new AbortController();
  private readonly pointers = new Set<number>();
  private candidate: { id: number; x: number; y: number; canceled: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, private readonly canDetonate: () => boolean,
    private readonly pick: (x: number, y: number) => GroundPoint | null,
    private readonly detonate: (point: GroundPoint) => void,
    private readonly preview: (point: GroundPoint | null) => void) {
    const options = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', event => {
      this.pointers.add(event.pointerId);
      if (this.pointers.size > 1) { if (this.candidate) this.candidate.canceled = true; this.preview(null); return; }
      if (this.enabled && event.isPrimary && event.button === 0 && this.canDetonate()) this.candidate = { id: event.pointerId, x: event.clientX, y: event.clientY, canceled: false };
    }, options);
    canvas.addEventListener('pointermove', event => {
      const c = this.candidate;
      if (c?.id === event.pointerId && event.buttons !== 1) c.canceled = true;
      if (c?.id === event.pointerId && Math.hypot(event.clientX - c.x, event.clientY - c.y) > 6) c.canceled = true;
      this.preview(this.enabled && this.canDetonate() && event.pointerType === 'mouse' && this.pointers.size === 0 ? this.pick(event.clientX, event.clientY) : null);
    }, options);
    canvas.addEventListener('pointerup', event => {
      const c = this.candidate;
      const tap = event.button === 0 && c?.id === event.pointerId && !c.canceled && this.pointers.size === 1
        && Math.hypot(event.clientX - c.x, event.clientY - c.y) <= 6;
      this.pointers.delete(event.pointerId);
      if (c?.id === event.pointerId) this.candidate = null;
      if (tap && this.enabled && this.canDetonate()) { const point = this.pick(event.clientX, event.clientY); if (point) this.detonate(point); }
    }, options);
    canvas.addEventListener('pointercancel', () => this.cancel(), options);
    canvas.addEventListener('pointerleave', () => this.preview(null), options);
    window.addEventListener('blur', () => this.cancel(), options);
  }
  cancel() { this.candidate = null; this.pointers.clear(); this.preview(null); }
  setEnabled(value: boolean) { this.enabled = value; this.cancel(); }
  dispose() { this.cancel(); this.events.abort(); }
}
