import { WEAPONS } from './config.ts';
import type { BattleSimulation } from './simulation.ts';
import type { BattleRenderer } from './renderer.ts';

const TEAM_NAMES = ['Plutonian', 'Sectoid'];

/** Floating card above the selected soldier: health and the guns he carries. */
export class SoldierCard {
  readonly element: HTMLElement;
  private id = 0;
  private lastContent = '';

  constructor(host: HTMLElement, private readonly onClose: () => void) {
    host.insertAdjacentHTML('beforeend', `<section id="soldier-card" class="soldier-card" hidden aria-live="polite" aria-label="Selected soldier">
      <div class="soldier-card-body"></div><button class="soldier-card-close" aria-label="Deselect soldier">×</button></section>`);
    this.element = host.querySelector('#soldier-card')!;
    this.element.querySelector('.soldier-card-close')!.addEventListener('click', () => this.onClose());
  }

  get selectedId() { return this.id; }
  show(id: number) { this.id = id; this.lastContent = ''; this.element.hidden = !id; }

  /** Refreshes text; cheap to call often because unchanged content is not rewritten. */
  update(sim: BattleSimulation) {
    if (!this.id) return;
    const i = sim.byId.get(this.id);
    if (i === undefined) { this.onClose(); return; }
    const alive = sim.hp[i] > 0, hp = Math.max(0, Math.ceil(sim.hp[i])), max = sim.tuning.health;
    const guns = WEAPONS.map((_, w) => w).filter(w => sim.inventory[i] & (1 << w));
    const content = `<div class="soldier-card-head"><span class="soldier-team team-${sim.team[i]}">${TEAM_NAMES[sim.team[i]]}</span><b>#${this.id}</b></div>
      ${alive ? `<div class="soldier-hp"><div class="soldier-hp-bar"><i style="width: ${Math.min(100, hp / max * 100)}%"></i></div><span>${hp} / ${max} HP</span></div>` : '<div class="soldier-kia">KILLED IN ACTION</div>'}
      <ul class="soldier-guns">${guns.length ? guns.map(w => `<li class="${alive && sim.weapon[i] === w ? 'active' : ''}"><span>${sim.weaponFor(w).name}</span><small>${sim.weaponFor(w).range} RNG</small></li>`).join('') : '<li class="unarmed">Unarmed</li>'}</ul>`;
    this.element.classList.toggle('dead', !alive);
    if (content !== this.lastContent) { this.element.querySelector('.soldier-card-body')!.innerHTML = content; this.lastContent = content; }
  }

  /** Keeps the card above the soldier on screen, clamped inside the viewport. */
  position(sim: BattleSimulation, renderer: BattleRenderer) {
    if (!this.id) return;
    const i = sim.byId.get(this.id), point = i === undefined ? null : renderer.soldierScreen(sim, i);
    this.element.classList.toggle('offscreen', !point);
    if (!point) return;
    const host = this.element.offsetParent as HTMLElement | null, width = host?.clientWidth ?? innerWidth, height = host?.clientHeight ?? innerHeight;
    const w = this.element.offsetWidth, h = this.element.offsetHeight, margin = 12;
    const x = Math.max(margin, Math.min(width - w - margin, point.x - w / 2));
    const y = Math.max(margin, Math.min(height - h - margin, point.y - h - 14));
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
