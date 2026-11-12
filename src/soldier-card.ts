import { WEAPONS } from './config.ts';
import type { BattleSimulation } from './simulation.ts';
import type { BattleRenderer } from './renderer.ts';
import type { SoldierRecord } from './soldiers.ts';
import { SEAT_COUNT, VEHICLE_TYPES } from './vehicle-types.ts';

const TEAM_NAMES = ['Plutonian', 'Sectoid'];

/** Floating card above the selected soldier: health and the guns he carries. */
export class SoldierCard {
  readonly element: HTMLElement;
  private id = 0;
  private vehicleId = 0;
  private lastContent = '';

  /** `record` looks up a soldier's roster entry by simulation id; anonymous soldiers show their number. */
  constructor(host: HTMLElement, private readonly onClose: () => void, private readonly record: (id: number) => SoldierRecord | undefined = () => undefined) {
    host.insertAdjacentHTML('beforeend', `<section id="soldier-card" class="soldier-card" hidden aria-live="polite" aria-label="Selected soldier">
      <div class="soldier-card-body"></div><button class="soldier-card-close" aria-label="Close inspection">×</button></section>`);
    this.element = host.querySelector('#soldier-card')!;
    this.element.querySelector('.soldier-card-close')!.addEventListener('click', () => this.onClose());
  }

  get selectedId() { return this.id; }
  get selectedVehicleId() { return this.vehicleId; }
  show(id: number, vehicleId = 0) {
    this.id = id; this.vehicleId = vehicleId; this.lastContent = ''; this.element.hidden = !id && !vehicleId;
    this.element.setAttribute('aria-label', vehicleId ? 'Selected truck' : 'Selected soldier');
  }

  /** Refreshes text; cheap to call often because unchanged content is not rewritten. */
  update(sim: BattleSimulation) {
    if (this.vehicleId) {
      const f = sim.vehicles, v = f.byId.get(this.vehicleId);
      if (v === undefined) { this.onClose(); return; }
      const type = VEHICLE_TYPES[f.type[v]], hp = Math.ceil(f.hp[v]), max = sim.tuning.truckHealth;
      let occupancy = 0;
      for (let role = 0; role < SEAT_COUNT; role++) if (f.seat(v, role) >= 0) occupancy++;
      const content = `<div class="soldier-card-head"><span class="soldier-team team-${f.team[v]}">${TEAM_NAMES[f.team[v]]} ${type.name}</span><b>#${this.vehicleId}</b></div>
        <div class="soldier-hp"><div class="soldier-hp-bar"><i style="width: ${Math.min(100, hp / max * 100)}%"></i></div><span>${hp} / ${max} HP</span></div>
        <ul class="soldier-guns" aria-label="Crew ${occupancy} of ${SEAT_COUNT}">${type.seats.map((seat, role) => {
          const i = f.seat(v, role);
          return `<li class="${i >= 0 ? 'active' : 'unarmed'}"><span>${seat.name}</span><small>${i >= 0 ? '#' + sim.id[i] : f.reservation(v, role) >= 0 ? 'Boarding' : 'Vacant'}</small></li>`;
        }).join('')}</ul>`;
      this.element.classList.remove('dead');
      this.paint(content);
      return;
    }
    if (!this.id) return;
    const i = sim.byId.get(this.id);
    if (i === undefined) { this.onClose(); return; }
    const alive = sim.hp[i] > 0, hp = Math.max(0, Math.ceil(sim.hp[i])), max = sim.tuning.health;
    const guns = WEAPONS.map((_, w) => w).filter(w => sim.inventory[i] & (1 << w));
    const record = this.record(this.id);
    const content = `<div class="soldier-card-head"><span class="soldier-team team-${sim.team[i]}">${TEAM_NAMES[sim.team[i]]}</span>${record ? `<b>${record.name} <small class="soldier-level">LV ${record.level}</small></b>` : `<b>#${this.id}</b>`}</div>
      ${alive ? `<div class="soldier-hp"><div class="soldier-hp-bar"><i style="width: ${Math.min(100, hp / max * 100)}%"></i></div><span>${hp} / ${max} HP</span></div>` : '<div class="soldier-kia">KILLED IN ACTION</div>'}
      <ul class="soldier-guns">${guns.length ? guns.map(w => `<li class="${alive && sim.weapon[i] === w ? 'active' : ''}"><span>${sim.weaponFor(w).name}</span><small>${sim.weaponFor(w).range} RNG</small></li>`).join('') : '<li class="unarmed">Unarmed</li>'}</ul>`;
    this.element.classList.toggle('dead', !alive);
    this.paint(content);
  }
  private paint(content: string) { if (content !== this.lastContent) { this.element.querySelector('.soldier-card-body')!.innerHTML = content; this.lastContent = content; } }

  /** Keeps the card above the soldier on screen, clamped inside the viewport. */
  position(sim: BattleSimulation, renderer: BattleRenderer) {
    if (!this.id && !this.vehicleId) return;
    const i = this.vehicleId ? sim.vehicles.byId.get(this.vehicleId) : sim.byId.get(this.id);
    const point = i === undefined ? null : this.vehicleId ? renderer.vehicleScreen(sim, i) : renderer.soldierScreen(sim, i);
    this.element.classList.toggle('offscreen', !point);
    if (!point) return;
    const host = this.element.offsetParent as HTMLElement | null, width = host?.clientWidth ?? innerWidth, height = host?.clientHeight ?? innerHeight;
    const w = this.element.offsetWidth, h = this.element.offsetHeight, margin = 12;
    const x = Math.max(margin, Math.min(width - w - margin, point.x - w / 2));
    const y = Math.max(margin, Math.min(height - h - margin, point.y - h - 14));
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
