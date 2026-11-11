import { WEAPONS, type Weapon } from './config.ts';
import { ARMY_ITEMS, copyEquipment, defaultEquipment, recipientCount, sameEquipment, validPercentage, type EquipmentSettings, type ItemId } from './equipment.ts';
import type { TuningPage } from './tuning-panel.ts';

const teams = ['Plutonians', 'Sectoids'];

/** Army equipment, shown as the "Equipment" tab of the tuning panel. */
export class EquipmentTab implements TuningPage {
  readonly id = 'equipment';
  readonly label = 'Army equipment';
  readonly short = 'Equipment';
  readonly content: HTMLElement;
  onChange = () => {};
  private values: EquipmentSettings;
  private active: EquipmentSettings;
  private count: number;

  constructor(values: EquipmentSettings, count: number, readonly change: (values: EquipmentSettings) => void) {
    this.values = copyEquipment(values); this.active = copyEquipment(values); this.count = count;
    this.content = document.createElement('div');
    this.content.className = 'equipment-page';
    this.content.innerHTML = `
      <p class="equipment-intro tuning-page-note">Share of each army carrying an item, assigned at random with exact quantities. Soldiers can carry several weapons and switch automatically.</p>
      <div class="equipment-armies"><span>Ⅰ PLUTONIANS</span><span>Ⅲ SECTOIDS</span></div>
      ${ARMY_ITEMS.map(item => {
        const gun = WEAPONS[item.weapon];
        return `<section class="equipment-item" data-item="${item.id}" data-search-row="${item.name} equipment weapon ${item.id}"><h2>${item.name}<span id="equipment-stats-${item.id}">${gun.damage} DMG · ${gun.range} RANGE · ${gun.interval}s / SHOT</span></h2><div class="equipment-columns">${teams.map((team, index) => `
          <div class="equipment-control"><label class="sr-only" for="equip-${index}-${item.id}">${item.name} — ${team} percentage</label>
            <div class="equipment-percent"><input id="equip-${index}-${item.id}" data-equipment-team="${index}" data-equipment-item="${item.id}" aria-describedby="equip-count-${index}-${item.id}" type="number" min="0" max="100" step="1" inputmode="numeric" value="${values[index][item.id]}"/><span>%</span></div>
            <input type="range" data-equipment-range="${item.id}" data-team="${index}" aria-label="${item.name} — ${team} percentage slider" min="0" max="100" step="1" value="${values[index][item.id]}"/>
            <output id="equip-count-${index}-${item.id}"></output>
          </div>`).join('')}</div></section>`;
      }).join('')}
      <p class="equipment-help tuning-page-note">Each item is assigned independently. At 100% for all three, every soldier carries all three. Soldiers assigned no weapons are unarmed. Equipment applies when a new battle starts. <button type="button" id="reset-equipment">Reset equipment</button></p>`;
    this.content.querySelector('#reset-equipment')!.addEventListener('click', () => this.reset());
    this.content.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      const item = (input.dataset.equipmentItem ?? input.dataset.equipmentRange) as ItemId | undefined;
      if (!item) return;
      const team = Number(input.dataset.equipmentTeam ?? input.dataset.team) as 0 | 1;
      const value = input.value === '' ? NaN : Number(input.value);
      if (!validPercentage(value)) { input.setAttribute('aria-invalid', 'true'); this.onChange(); return; }
      // Moving the slider also corrects an invalid entry in its corresponding number field.
      this.content.querySelector(`#equip-${team}-${item}`)!.removeAttribute('aria-invalid');
      input.removeAttribute('aria-invalid'); this.values[team][item] = value;
      this.change(copyEquipment(this.values)); this.refresh();
    });
    this.refresh();
  }

  get valid() { return !this.content.querySelector('[aria-invalid="true"]'); }
  error() { return this.valid ? null : 'Enter a whole equipment percentage from 0 to 100.'; }
  pending() { return !sameEquipment(this.values, this.active); }
  changed() { return !sameEquipment(this.values, defaultEquipment()); }
  reset() { this.clearInvalid(); this.values = defaultEquipment(); this.change(copyEquipment(this.values)); this.refresh(); }
  updateCount(count: number) { this.count = count; this.refresh(); }
  updateRifle(gun: Weapon) { this.content.querySelector('#equipment-stats-rifle')!.textContent = `${gun.damage} DMG · ${gun.range} RANGE · ${gun.interval}s / SHOT`; }
  sync(values: EquipmentSettings, active: EquipmentSettings, count: number) {
    this.clearInvalid(); this.values = copyEquipment(values); this.active = copyEquipment(active); this.count = count; this.refresh();
  }
  private clearInvalid() { for (const input of this.content.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid'); }
  private refresh() {
    for (const team of [0, 1] as const) for (const item of ARMY_ITEMS) {
      const number = this.content.querySelector<HTMLInputElement>(`#equip-${team}-${item.id}`)!;
      if (document.activeElement !== number && !number.hasAttribute('aria-invalid')) number.value = String(this.values[team][item.id]);
      this.content.querySelector<HTMLInputElement>(`[data-equipment-range="${item.id}"][data-team="${team}"]`)!.value = String(this.values[team][item.id]);
      this.content.querySelector(`#equip-count-${team}-${item.id}`)!.textContent = `${recipientCount(this.count, this.values[team][item.id])} / ${this.count} soldiers`;
      number.closest('.equipment-control')!.classList.toggle('changed', this.values[team][item.id] !== this.active[team][item.id]);
    }
    this.onChange();
  }
}
