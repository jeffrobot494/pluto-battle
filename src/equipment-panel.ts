import { WEAPONS, type Weapon } from './config.ts';
import { ARMY_ITEMS, copyEquipment, defaultEquipment, recipientCount, sameEquipment, validPercentage, type EquipmentSettings, type ItemId } from './equipment.ts';

const teams = ['Plutonians', 'Sectoids'];

export class EquipmentPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;
  private values: EquipmentSettings;
  private active: EquipmentSettings;
  private count: number;
  private status: HTMLElement;
  private apply: HTMLButtonElement;

  constructor(host: HTMLElement, values: EquipmentSettings, count: number, readonly change: (values: EquipmentSettings) => void, readonly deploy: () => boolean) {
    this.values = copyEquipment(values); this.active = copyEquipment(values); this.count = count;
    host.insertAdjacentHTML('beforeend', `
      <button id="equipment-toggle" class="tuning-toggle equipment-toggle" aria-expanded="false" aria-controls="equipment-panel" title="Army equipment (E)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 7h14v10H3zM7 7V3h6v4M3 11h14M8 10v3h4v-3"/></svg><span>Equipment</span><span class="tuning-chevron">⌄</span></button>
      <aside id="equipment-panel" hidden aria-label="Army equipment">
        <div class="tuning-heading"><div>ARMY EQUIPMENT<small>Random recipients · exact quantities</small></div><button id="close-equipment" aria-label="Collapse equipment panel">×</button></div>
        <div class="equipment-scroll">
          <p class="equipment-intro">Set the share of each army carrying an item. Soldiers can carry several weapons and switch automatically.</p>
          <div class="equipment-armies"><span>Ⅰ PLUTONIANS</span><span>Ⅲ SECTOIDS</span></div>
          ${ARMY_ITEMS.map(item => {
            const gun = WEAPONS[item.weapon];
            return `<section class="equipment-item" data-item="${item.id}"><h2>${item.name}<span id="equipment-stats-${item.id}">${gun.damage} DMG · ${gun.range} RANGE · ${gun.interval}s / SHOT</span></h2><div class="equipment-columns">${teams.map((team, index) => `
              <div class="equipment-control"><label class="sr-only" for="equip-${index}-${item.id}">${item.name} — ${team} percentage</label>
                <div class="equipment-percent"><input id="equip-${index}-${item.id}" data-equipment-team="${index}" data-equipment-item="${item.id}" aria-describedby="equip-count-${index}-${item.id}" type="number" min="0" max="100" step="1" inputmode="numeric" value="${values[index][item.id]}"/><span>%</span></div>
                <input type="range" data-equipment-range="${item.id}" data-team="${index}" aria-label="${item.name} — ${team} percentage slider" min="0" max="100" step="1" value="${values[index][item.id]}"/>
                <output id="equip-count-${index}-${item.id}"></output>
              </div>`).join('')}</div></section>`;
          }).join('')}
          <p class="equipment-help">Each item is assigned independently. At 100% for all three, every soldier carries all three. Soldiers assigned no weapons are unarmed.</p>
        </div>
        <div class="tuning-footer"><p id="equipment-status" role="status" aria-live="polite"></p><div><button id="reset-equipment">Reset defaults</button><button id="deploy-equipment">New battle ↗</button></div></div>
      </aside>`);
    this.element = host.querySelector('#equipment-panel')!; this.toggleButton = host.querySelector('#equipment-toggle')!;
    this.status = this.element.querySelector('#equipment-status')!; this.apply = this.element.querySelector('#deploy-equipment')!;
    this.toggleButton.addEventListener('click', () => this.toggle());
    this.element.querySelector('#close-equipment')!.addEventListener('click', () => this.toggle(false));
    this.apply.addEventListener('click', () => { if (this.valid) this.deploy(); });
    this.element.querySelector('#reset-equipment')!.addEventListener('click', () => {
      this.clearInvalid(); this.values = defaultEquipment(); this.change(copyEquipment(this.values)); this.refresh();
    });
    this.element.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      const item = (input.dataset.equipmentItem ?? input.dataset.equipmentRange) as ItemId | undefined;
      if (!item) return;
      const team = Number(input.dataset.equipmentTeam ?? input.dataset.team) as 0 | 1;
      const value = input.value === '' ? NaN : Number(input.value);
      if (!validPercentage(value)) { input.setAttribute('aria-invalid', 'true'); this.refreshStatus(); return; }
      // Moving the slider also corrects an invalid entry in its corresponding number field.
      this.element.querySelector(`#equip-${team}-${item}`)!.removeAttribute('aria-invalid');
      input.removeAttribute('aria-invalid'); this.values[team][item] = value;
      this.change(copyEquipment(this.values)); this.refresh();
    });
    this.refresh();
  }

  get valid() { return !this.element.querySelector('[aria-invalid="true"]'); }
  toggle(force?: boolean) {
    const open = force ?? this.element.hidden; this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }
  updateCount(count: number) { this.count = count; this.refresh(); }
  updateRifle(gun: Weapon) { this.element.querySelector('#equipment-stats-rifle')!.textContent = `${gun.damage} DMG · ${gun.range} RANGE · ${gun.interval}s / SHOT`; }
  sync(values: EquipmentSettings, active: EquipmentSettings, count: number) {
    this.clearInvalid(); this.values = copyEquipment(values); this.active = copyEquipment(active); this.count = count; this.refresh();
  }
  private clearInvalid() { for (const input of this.element.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid'); }
  private refreshStatus() {
    const pending = !sameEquipment(this.values, this.active);
    this.apply.disabled = !this.valid; this.status.classList.toggle('tuning-error', !this.valid);
    this.status.textContent = !this.valid ? 'Enter a whole percentage from 0 to 100.' : pending
      ? 'Equipment changes ready. Start a new battle to apply.'
      : 'Saved on this device. Equipment is assigned at deployment and stays fixed during battle.';
    this.toggleButton.classList.toggle('has-pending', pending);
  }
  private refresh() {
    for (const team of [0, 1] as const) for (const item of ARMY_ITEMS) {
      const number = this.element.querySelector<HTMLInputElement>(`#equip-${team}-${item.id}`)!;
      if (document.activeElement !== number && !number.hasAttribute('aria-invalid')) number.value = String(this.values[team][item.id]);
      this.element.querySelector<HTMLInputElement>(`[data-equipment-range="${item.id}"][data-team="${team}"]`)!.value = String(this.values[team][item.id]);
      this.element.querySelector(`#equip-count-${team}-${item.id}`)!.textContent = `${recipientCount(this.count, this.values[team][item.id])} / ${this.count} soldiers`;
      number.closest('.equipment-control')!.classList.toggle('changed', this.values[team][item.id] !== this.active[team][item.id]);
    }
    this.refreshStatus();
  }
}
