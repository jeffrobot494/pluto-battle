import { DEFAULT_TUNING, TUNING, deploymentError, validValue, type TuningKey, type TuningValues } from './tuning.ts';
import { readSetting, writeSetting } from './settings-store.ts';

const SHORT_NAMES: Record<string, string> = {
  'Physics & explosions': 'Physics', 'Deployment': 'Deploy', 'Soldiers & weapons': 'Soldiers', 'Formation': 'Formation',
  'Targeting': 'Target', 'Crowd steering': 'Crowd', 'Hit feedback': 'Hits',
};
const tabKey = 'pluto-battle-tuning-tab', helpKey = 'pluto-battle-tuning-help';
const IDLE_STATUS = 'Live settings apply instantly; ↻ settings need a new battle. Saved on this device.';

export class TuningPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;
  private status: HTMLElement;
  private apply: HTMLButtonElement;
  private filter: HTMLInputElement;
  private groups: string[];
  private tab: number;
  private values: TuningValues;
  private active: TuningValues;

  constructor(host: HTMLElement, values: TuningValues, readonly change: (values: TuningValues) => void, readonly deploy: () => boolean) {
    this.values = { ...values }; this.active = { ...values };
    this.groups = [...new Set(TUNING.map(d => d.group))];
    const savedTab = Number(readSetting(tabKey));
    this.tab = Number.isInteger(savedTab) && savedTab >= 0 && savedTab < this.groups.length ? savedTab : 0;
    const control = (def: (typeof TUNING)[number]) => `
      <div class="tuning-control${def.key === 'seed' ? ' no-range' : ''}" data-control="${def.key}" data-group="${this.groups.indexOf(def.group)}" title="${def.help}">
        <label for="tune-${def.key}">${def.label}${def.restart ? '<span class="tuning-restart" title="Applies when a new battle starts" aria-label="applies on new battle">↻</span>' : ''}</label>
        ${def.key !== 'seed' ? `<input type="range" data-tuning-range="${def.key}" aria-label="${def.label} slider" min="${def.min}" max="${def.max}" step="${def.step}" value="${values[def.key]}"/>` : ''}
        <div class="tuning-number"><input id="tune-${def.key}" data-tuning-key="${def.key}" aria-describedby="help-${def.key}" type="number" min="${def.min}" max="${def.max}" step="any" ${def.step === 1 ? 'inputmode="numeric"' : 'inputmode="decimal"'} value="${values[def.key]}"/>${def.unit ? `<span>${def.unit}</span>` : ''}</div>
        <button type="button" class="tuning-reset-one" data-reset="${def.key}" title="Reset to default (${DEFAULT_TUNING[def.key]})" aria-label="Reset ${def.label}">↺</button>
        <p id="help-${def.key}">${def.help}</p>
      </div>`;
    host.insertAdjacentHTML('beforeend', `
      <button id="tuning-toggle" class="tuning-toggle" aria-expanded="false" aria-controls="tuning-panel" title="Battle tuning (T)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 5h14M3 10h14M3 15h14"/><path d="M7 2v6m6-1v6m-5-1v6" stroke-width="3"/></svg><span>Tuning</span><small>${TUNING.length}</small><span class="tuning-chevron">⌄</span></button>
      <aside id="tuning-panel" hidden aria-label="Battle tuning">
        <div class="tuning-heading">
          <span>BATTLE TUNING</span>
          <input type="search" id="tuning-filter" placeholder="Search…" aria-label="Search tuning settings" autocomplete="off"/>
          <button id="tuning-help" aria-pressed="false" title="Show descriptions">?</button>
          <button id="close-tuning" aria-label="Collapse tuning panel">×</button>
        </div>
        <div class="tuning-tabs" role="tablist" aria-label="Tuning groups">${this.groups.map((group, i) => `<button role="tab" class="tuning-tab" data-tab="${i}" aria-controls="tuning-scroll" title="${group}">${SHORT_NAMES[group] ?? group}<i></i></button>`).join('')}</div>
        <div class="tuning-scroll" id="tuning-scroll" role="tabpanel">${this.groups.map((group, i) => `<h3 class="tuning-section" data-section="${i}">${group}</h3>${TUNING.filter(d => d.group === group).map(control).join('')}`).join('')}
          <p class="tuning-empty" hidden>No settings match.</p></div>
        <div class="tuning-footer"><p id="tuning-status" role="status" aria-live="polite"></p><div><button id="reset-tuning">Reset all</button><button id="deploy-tuning">New battle ↗</button></div></div>
      </aside>`);
    this.element = host.querySelector('#tuning-panel')!; this.toggleButton = host.querySelector('#tuning-toggle')!;
    this.status = this.element.querySelector('#tuning-status')!; this.apply = this.element.querySelector('#deploy-tuning')!;
    this.filter = this.element.querySelector('#tuning-filter')!;
    const help = this.element.querySelector<HTMLButtonElement>('#tuning-help')!;
    const setHelp = (on: boolean) => { this.element.classList.toggle('show-help', on); help.setAttribute('aria-pressed', String(on)); };
    setHelp(readSetting(helpKey) === '1');
    help.addEventListener('click', () => { const on = !this.element.classList.contains('show-help'); setHelp(on); writeSetting(helpKey, on ? '1' : '0'); });
    this.toggleButton.addEventListener('click', () => this.toggle());
    this.element.querySelector('#close-tuning')!.addEventListener('click', () => this.toggle(false));
    this.apply.addEventListener('click', () => this.deploy());
    this.element.querySelector('#reset-tuning')!.addEventListener('click', () => { this.values = { ...DEFAULT_TUNING }; this.change({ ...this.values }); this.refresh(); });
    this.element.querySelector('.tuning-tabs')!.addEventListener('click', event => {
      const tab = (event.target as Element).closest<HTMLElement>('[data-tab]');
      if (!tab) return;
      this.tab = Number(tab.dataset.tab); writeSetting(tabKey, String(this.tab));
      this.filter.value = ''; this.layout(); this.element.querySelector('.tuning-scroll')!.scrollTop = 0;
    });
    this.element.querySelector('.tuning-tabs')!.addEventListener('keydown', event => {
      const e = event as KeyboardEvent;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = (this.tab + (e.key === 'ArrowRight' ? 1 : -1) + this.groups.length) % this.groups.length;
      this.element.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)!.click();
      this.element.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)!.focus();
    });
    this.element.addEventListener('click', event => {
      const key = (event.target as HTMLElement).dataset?.reset as TuningKey | undefined;
      if (!key) return;
      this.values[key] = DEFAULT_TUNING[key]; this.change({ ...this.values }); this.refresh();
    });
    this.filter.addEventListener('input', () => this.layout());
    this.filter.addEventListener('keydown', event => { if (event.key === 'Escape' && this.filter.value) { event.stopPropagation(); this.filter.value = ''; this.layout(); } });
    this.element.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      const key = (input.dataset.tuningKey ?? input.dataset.tuningRange) as TuningKey | undefined;
      if (!key) return;
      const value = input.value === '' ? NaN : Number(input.value);
      if (!validValue(key, value)) { input.setAttribute('aria-invalid', 'true'); this.status.textContent = 'Enter a value within the control’s limits.'; this.status.classList.add('tuning-error'); this.apply.disabled = true; return; }
      input.removeAttribute('aria-invalid'); this.values[key] = value; this.change({ ...this.values }); this.refresh();
    });
    this.layout();
    this.refresh();
  }

  toggle(force?: boolean) {
    const open = force ?? this.element.hidden; this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }
  sync(values: TuningValues, active: TuningValues) { this.values = { ...values }; this.active = { ...active }; this.refresh(); }

  private layout() {
    const query = this.filter.value.trim().toLowerCase();
    const searching = query.length > 0, matchedGroups = new Set<number>();
    this.element.classList.toggle('searching', searching);
    for (const def of TUNING) {
      const row = this.element.querySelector<HTMLElement>(`[data-control="${def.key}"]`)!, group = Number(row.dataset.group);
      const show = searching ? `${def.label} ${def.help} ${def.group}`.toLowerCase().includes(query) : group === this.tab;
      row.hidden = !show; if (show) matchedGroups.add(group);
    }
    this.element.querySelectorAll<HTMLElement>('[data-section]').forEach(h => { h.hidden = !searching || !matchedGroups.has(Number(h.dataset.section)); });
    this.element.querySelector<HTMLElement>('.tuning-empty')!.hidden = matchedGroups.size > 0;
    this.element.querySelectorAll<HTMLElement>('[data-tab]').forEach(t => {
      const selected = !searching && Number(t.dataset.tab) === this.tab;
      t.setAttribute('aria-selected', String(selected)); t.tabIndex = selected || (searching && t.dataset.tab === '0') ? 0 : -1;
    });
  }
  private refresh() {
    const changedGroups = new Set<string>(), pendingGroups = new Set<string>();
    for (const def of TUNING) {
      const number = this.element.querySelector<HTMLInputElement>(`[data-tuning-key="${def.key}"]`)!;
      const range = this.element.querySelector<HTMLInputElement>(`[data-tuning-range="${def.key}"]`);
      if (document.activeElement !== number) { number.value = String(this.values[def.key]); number.removeAttribute('aria-invalid'); }
      if (range) range.value = String(this.values[def.key]);
      const changed = this.values[def.key] !== DEFAULT_TUNING[def.key];
      if (changed) changedGroups.add(def.group);
      if (def.restart && this.values[def.key] !== this.active[def.key]) pendingGroups.add(def.group);
      this.element.querySelector(`[data-control="${def.key}"]`)!.classList.toggle('changed', changed);
    }
    this.groups.forEach((group, i) => {
      const tab = this.element.querySelector(`[data-tab="${i}"]`)!;
      tab.classList.toggle('changed', changedGroups.has(group)); tab.classList.toggle('pending', pendingGroups.has(group));
    });
    const error = deploymentError(this.values), pending = pendingGroups.size > 0;
    this.status.classList.toggle('tuning-error', !!error); this.apply.disabled = !!error;
    this.status.textContent = error ?? (pending ? 'Deployment changes ready. Start a new battle to apply.' : IDLE_STATUS);
    this.toggleButton.classList.toggle('has-pending', pending);
  }
}
