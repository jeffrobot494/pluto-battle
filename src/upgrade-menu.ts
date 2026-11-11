import { WEAPONS } from './config.ts';
import { TARGET_KEY, UPGRADE_TARGETS, UPGRADES, type Upgrade, type UpgradeId, type UpgradeTarget, type UpgradeTargetId } from './upgrades.ts';

/**
 * Mutually exclusive upgrade toggles. Pressing the active one turns it off.
 * A segmented switch picks which army a held zone upgrades.
 */
export class UpgradeMenu {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private current: Upgrade | null = null;
  private currentTarget: UpgradeTarget = UPGRADE_TARGETS[0];
  private statusTimer = 0;

  constructor(host: HTMLElement, private readonly onChange: (upgrade: Upgrade | null) => void) {
    host.insertAdjacentHTML('beforeend', `
      <div class="upgrade-controls">
        <nav id="upgrade-menu" class="upgrade-menu" aria-label="Weapon upgrades">
          <span class="upgrade-title">UPGRADE</span>
          <div class="upgrade-target" role="radiogroup" aria-label="Zone upgrades (${TARGET_KEY})" title="Army a held zone upgrades (${TARGET_KEY})">
            ${UPGRADE_TARGETS.map(t => `<button role="radio" data-target="${t.id}" aria-checked="${t === this.currentTarget}" style="--target: ${t.color}" title="Zone upgrades ${t.name} (${TARGET_KEY})">${t.label}</button>`).join('')}
          </div>
          ${UPGRADES.map(u => `<button class="upgrade-button" data-upgrade="${u.id}" aria-pressed="false" style="--upgrade: ${u.color}" title="${u.name}: ${WEAPONS[u.weapon].range} range (${u.key})">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${u.icon}</svg>
            <span>${u.label}</span><small>RNG ${WEAPONS[u.weapon].range}</small><kbd aria-hidden="true">${u.key}</kbd></button>`).join('')}
        </nav>
        <p id="upgrade-status" class="upgrade-status" role="status" aria-live="polite"></p>
      </div>`);
    this.element = host.querySelector('#upgrade-menu')!;
    this.status = host.querySelector('#upgrade-status')!;
    this.element.addEventListener('click', event => {
      const target = (event.target as Element).closest<HTMLButtonElement>('[data-target]');
      if (target) { this.setTarget(target.dataset.target as UpgradeTargetId); return; }
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-upgrade]');
      if (button) this.toggle(button.dataset.upgrade as UpgradeId);
    });
    this.paintTarget();
  }

  get selected() { return this.current; }
  get target() { return this.currentTarget; }
  setTarget(id: UpgradeTargetId) {
    const next = UPGRADE_TARGETS.find(t => t.id === id);
    if (!next || next === this.currentTarget) return;
    this.currentTarget = next; this.paintTarget();
    this.say(this.current ? this.armedMessage() : `Zone upgrades ${next.name}`);
  }
  /** Steps to the next target: Plutonians → Sectoids → both → Plutonians. */
  cycleTarget() {
    const index = UPGRADE_TARGETS.indexOf(this.currentTarget);
    this.setTarget(UPGRADE_TARGETS[(index + 1) % UPGRADE_TARGETS.length].id);
  }
  private paintTarget() {
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-target]')) button.setAttribute('aria-checked', String(button.dataset.target === this.currentTarget.id));
    this.element.style.setProperty('--zone-target', this.currentTarget.color);
  }
  private armedMessage() { return `${this.current!.name} → ${this.currentTarget.name}: hold to upgrade an area, or tap a soldier`; }
  toggle(id: UpgradeId) { this.select(this.current?.id === id ? null : id); }
  select(id: UpgradeId | null) {
    const next = UPGRADES.find(u => u.id === id) ?? null;
    if (next === this.current) return;
    this.current = next;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-upgrade]')) button.setAttribute('aria-pressed', String(button.dataset.upgrade === id));
    this.element.style.setProperty('--active-upgrade', next?.color ?? 'transparent');
    this.say(next ? this.armedMessage() : '');
    this.onChange(next);
  }
  /** Shows a short message near the controls; it fades after a few seconds. */
  say(message: string, seconds = 4) {
    clearTimeout(this.statusTimer);
    this.status.textContent = message; this.status.classList.toggle('visible', !!message);
    if (message) this.statusTimer = window.setTimeout(() => this.status.classList.remove('visible'), seconds * 1000);
  }
}
