import type { BattleRoster, Roster } from './soldiers.ts';
import type { TuningPage } from './tuning-panel.ts';

/** Soldier pool summary, shown as the "Roster" tab of the tuning panel. */
export class SoldiersTab implements TuningPage {
  readonly id = 'roster';
  readonly label = 'Soldier roster';
  readonly short = 'Roster';
  readonly content: HTMLElement;
  onChange = () => {};
  private readonly summary: HTMLElement;
  private readonly resetButton: HTMLButtonElement;
  private confirmTimer = 0;

  constructor(private readonly roster: Roster, private readonly onReset: () => void, private readonly onView: () => void) {
    this.content = document.createElement('div');
    this.content.className = 'roster-page';
    this.content.innerHTML = `
      <p class="roster-intro tuning-page-note">Plutonians are drawn at random from a persistent pool each battle. Survivors gain a level when the battle ends.</p>
      <div class="roster-row" data-search-row="soldiers roster pool level reset view names">
        <p id="roster-summary"></p>
        <div class="roster-actions"><button type="button" id="roster-view">View</button><button type="button" id="roster-reset">Reset</button></div>
      </div>
      <p class="roster-help tuning-page-note">View lists soldiers alive in this battle. Reset replaces the pool with fresh level-0 recruits.</p>`;
    this.summary = this.content.querySelector('#roster-summary')!;
    this.resetButton = this.content.querySelector('#roster-reset')!;
    this.content.querySelector('#roster-view')!.addEventListener('click', () => this.onView());
    // A second tap confirms, so a stray tap cannot wipe every soldier's progress.
    this.resetButton.addEventListener('click', () => {
      if (!this.confirmTimer) { this.resetButton.textContent = 'Confirm reset'; this.resetButton.classList.add('confirming'); this.confirmTimer = window.setTimeout(() => this.disarm(), 3000); return; }
      this.disarm(); this.onReset(); this.refresh();
    });
    this.refresh();
  }

  private disarm() { clearTimeout(this.confirmTimer); this.confirmTimer = 0; this.resetButton.textContent = 'Reset'; this.resetButton.classList.remove('confirming'); }
  refresh() {
    const levels = this.roster.list().map(r => r.level);
    const top = levels.reduce((a, b) => Math.max(a, b), 0), veterans = levels.filter(l => l > 0).length;
    this.summary.innerHTML = `<b>${levels.length}</b> soldiers · <b>${veterans}</b> veterans · top level <b>${top}</b>`;
  }
  error() { return null; }
  pending() { return false; }
  changed() { return false; }
  /** "Reset all" in the tuning panel restores settings only; soldier progress needs the explicit Reset button. */
  reset() {}
}

/** Fullscreen list of the Plutonians alive in the current battle. */
export class SoldierList {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private lastKey = '';

  constructor(host: HTMLElement, private readonly onSelect: (simId: number) => void) {
    host.insertAdjacentHTML('beforeend', `<section id="soldier-list" class="soldier-list" hidden role="dialog" aria-modal="true" aria-label="Living soldiers">
      <header><span>Ⅰ PLUTONIANS IN THE FIELD</span><small id="soldier-list-count"></small><button type="button" id="close-soldier-list" aria-label="Close soldier list">×</button></header>
      <ol id="soldier-list-items"></ol></section>`);
    this.element = host.querySelector('#soldier-list')!;
    this.list = this.element.querySelector('#soldier-list-items')!;
    this.count = this.element.querySelector('#soldier-list-count')!;
    this.element.querySelector('#close-soldier-list')!.addEventListener('click', () => this.toggle(false));
    this.list.addEventListener('click', event => {
      const item = (event.target as Element).closest<HTMLElement>('[data-sim-id]');
      if (item) { this.onSelect(Number(item.dataset.simId)); this.toggle(false); }
    });
  }

  get open() { return !this.element.hidden; }
  toggle(force?: boolean, battle?: BattleRoster) {
    const open = force ?? this.element.hidden;
    this.element.hidden = !open; this.lastKey = '';
    if (open && battle) this.update(battle);
  }
  /** Rebuilds only when the set of living soldiers or their levels changed. */
  update(battle: BattleRoster) {
    if (!this.open) return;
    const living = battle.living().sort((a, b) => b.record.level - a.record.level || a.record.name.localeCompare(b.record.name));
    const key = living.map(s => `${s.simId}:${s.record.level}`).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.count.textContent = `${living.length} ALIVE`;
    this.list.innerHTML = living.length
      ? living.map(s => `<li data-sim-id="${s.simId}"><span>${s.record.name}</span><b>${s.record.level}</b></li>`).join('')
      : '<li class="empty">No Plutonians alive.</li>';
  }
}
