import { DEFAULT_TUNING, TUNING, deploymentError, validValue, type TuningKey, type TuningValues } from './tuning.ts';

export class TuningPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;
  private status: HTMLElement;
  private apply: HTMLButtonElement;
  private values: TuningValues;
  private active: TuningValues;

  constructor(host: HTMLElement, values: TuningValues, readonly change: (values: TuningValues) => void, readonly deploy: () => boolean) {
    this.values = { ...values }; this.active = { ...values };
    const groups = [...new Set(TUNING.map(d => d.group))];
    host.insertAdjacentHTML('beforeend', `
      <button id="tuning-toggle" class="tuning-toggle" aria-expanded="false" aria-controls="tuning-panel" title="Battle tuning (T)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 5h14M3 10h14M3 15h14"/><path d="M7 2v6m6-1v6m-5-1v6" stroke-width="3"/></svg><span>Tuning</span><small>25</small><span class="tuning-chevron">⌄</span></button>
      <aside id="tuning-panel" hidden aria-label="Battle tuning">
        <div class="tuning-heading"><div>BATTLE TUNING<small>Shared by both armies</small></div><button id="close-tuning" aria-label="Collapse tuning panel">×</button></div>
        <div class="tuning-scroll">${groups.map(group => `<details class="tuning-group" open><summary>${group}<span>${TUNING.filter(d => d.group === group).length}</span></summary>${TUNING.filter(d => d.group === group).map(def => `
          <div class="tuning-control" data-control="${def.key}"><div class="tuning-label"><label for="tune-${def.key}">${def.label}</label><span class="tuning-mode ${def.restart ? 'on-restart' : ''}">${def.restart ? 'NEW BATTLE' : 'LIVE'}</span></div>
          <div class="tuning-inputs">${def.key !== 'seed' ? `<input type="range" data-tuning-range="${def.key}" aria-label="${def.label} slider" min="${def.min}" max="${def.max}" step="${def.step}" value="${values[def.key]}"/>` : ''}<div class="tuning-number"><input id="tune-${def.key}" data-tuning-key="${def.key}" aria-describedby="help-${def.key}" type="number" min="${def.min}" max="${def.max}" step="any" ${def.step === 1 ? 'inputmode="numeric"' : 'inputmode="decimal"'} value="${values[def.key]}"/><span>${def.unit}</span></div></div>
          <p id="help-${def.key}">${def.help}</p></div>`).join('')}</details>`).join('')}</div>
        <div class="tuning-footer"><p id="tuning-status" role="status" aria-live="polite"></p><div><button id="reset-tuning">Reset defaults</button><button id="deploy-tuning">New battle ↗</button></div></div>
      </aside>`);
    this.element = host.querySelector('#tuning-panel')!; this.toggleButton = host.querySelector('#tuning-toggle')!;
    this.status = this.element.querySelector('#tuning-status')!; this.apply = this.element.querySelector('#deploy-tuning')!;
    this.toggleButton.addEventListener('click', () => this.toggle());
    this.element.querySelector('#close-tuning')!.addEventListener('click', () => this.toggle(false));
    this.apply.addEventListener('click', () => this.deploy());
    this.element.querySelector('#reset-tuning')!.addEventListener('click', () => { this.values = { ...DEFAULT_TUNING }; this.change({ ...this.values }); this.refresh(); });
    this.element.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      const key = (input.dataset.tuningKey ?? input.dataset.tuningRange) as TuningKey | undefined;
      if (!key) return;
      const value = input.value === '' ? NaN : Number(input.value);
      if (!validValue(key, value)) { input.setAttribute('aria-invalid', 'true'); this.status.textContent = 'Enter a value within the control’s limits.'; this.status.classList.add('tuning-error'); this.apply.disabled = true; return; }
      input.removeAttribute('aria-invalid'); this.values[key] = value; this.change({ ...this.values }); this.refresh();
    });
    this.refresh();
  }

  toggle(force?: boolean) {
    const open = force ?? this.element.hidden; this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }
  sync(values: TuningValues, active: TuningValues) { this.values = { ...values }; this.active = { ...active }; this.refresh(); }
  private refresh() {
    for (const def of TUNING) {
      const number = this.element.querySelector<HTMLInputElement>(`[data-tuning-key="${def.key}"]`)!;
      const range = this.element.querySelector<HTMLInputElement>(`[data-tuning-range="${def.key}"]`);
      if (document.activeElement !== number) { number.value = String(this.values[def.key]); number.removeAttribute('aria-invalid'); }
      if (range) range.value = String(this.values[def.key]);
      this.element.querySelector(`[data-control="${def.key}"]`)!.classList.toggle('changed', this.values[def.key] !== DEFAULT_TUNING[def.key]);
    }
    const error = deploymentError(this.values), pending = TUNING.some(d => d.restart && this.values[d.key] !== this.active[d.key]);
    this.status.classList.toggle('tuning-error', !!error); this.apply.disabled = !!error;
    this.status.textContent = error ?? (pending ? 'Deployment changes ready. Start a new battle to apply.' : 'Live settings apply immediately. Changes are saved on this device.');
    this.toggleButton.classList.toggle('has-pending', pending);
  }
}
