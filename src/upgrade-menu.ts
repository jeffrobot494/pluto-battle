import { WEAPONS } from './config.ts';
import { UPGRADES, type Upgrade, type UpgradeId } from './upgrades.ts';

/** Right-edge rail of mutually exclusive upgrade toggles. Pressing the active one turns it off. */
export class UpgradeMenu {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private current: Upgrade | null = null;
  private statusTimer = 0;

  constructor(host: HTMLElement, private readonly onChange: (upgrade: Upgrade | null) => void) {
    host.insertAdjacentHTML('beforeend', `
      <nav id="upgrade-menu" class="upgrade-menu" aria-label="Weapon upgrades">
        <span class="upgrade-title">UPGRADE</span>
        ${UPGRADES.map(u => `<button class="upgrade-button" data-upgrade="${u.id}" aria-pressed="false" style="--upgrade: ${u.color}" title="${u.name}: ${WEAPONS[u.weapon].range} range (${u.key})">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${u.icon}</svg>
          <span>${u.label}</span><small>RNG ${WEAPONS[u.weapon].range}</small><kbd aria-hidden="true">${u.key}</kbd></button>`).join('')}
      </nav>
      <p id="upgrade-status" class="upgrade-status" role="status" aria-live="polite"></p>`);
    this.element = host.querySelector('#upgrade-menu')!;
    this.status = host.querySelector('#upgrade-status')!;
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-upgrade]');
      if (button) this.toggle(button.dataset.upgrade as UpgradeId);
    });
  }

  get selected() { return this.current; }
  toggle(id: UpgradeId) { this.select(this.current?.id === id ? null : id); }
  select(id: UpgradeId | null) {
    const next = UPGRADES.find(u => u.id === id) ?? null;
    if (next === this.current) return;
    this.current = next;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-upgrade]')) button.setAttribute('aria-pressed', String(button.dataset.upgrade === id));
    this.element.style.setProperty('--active-upgrade', next?.color ?? 'transparent');
    this.say(next ? `${next.name}: hold to upgrade an area, or tap a soldier` : '');
    this.onChange(next);
  }
  /** Shows a short message beside the rail; it fades after a few seconds. */
  say(message: string, seconds = 4) {
    clearTimeout(this.statusTimer);
    this.status.textContent = message; this.status.classList.toggle('visible', !!message);
    if (message) this.statusTimer = window.setTimeout(() => this.status.classList.remove('visible'), seconds * 1000);
  }
}
