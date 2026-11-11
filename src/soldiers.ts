import { readSetting, writeSetting } from './settings-store.ts';
import type { BattleSimulation, Team } from './simulation.ts';

/**
 * Persistent Plutonian soldiers. Records outlive battles: each battle drafts a random
 * subset of the pool into the formation, and survivors gain a level when it ends.
 * Records carry only a name and level for now; future properties belong here.
 */
export interface SoldierRecord { id: number; name: string; level: number }

export const ROSTER_SIZE = 1000;
export const NAME_MAX = 14;
export const SOLDIERS_KEY = 'pluto-battle-soldiers-v1';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** 1–14 random letters, first one capitalised. */
export function randomName(rng: () => number = Math.random) {
  const length = 1 + Math.floor(rng() * NAME_MAX);
  let name = '';
  for (let i = 0; i < length; i++) name += LETTERS[Math.floor(rng() * LETTERS.length)];
  return name[0].toUpperCase() + name.slice(1);
}
export function validName(name: unknown): name is string { return typeof name === 'string' && /^[A-Za-z]{1,14}$/.test(name); }
function validLevel(level: unknown): level is number { return typeof level === 'number' && Number.isInteger(level) && level >= 0; }

export class Roster {
  private records = new Map<number, SoldierRecord>();
  private nextId = 1;
  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) { this.rng = rng; }

  get size() { return this.records.size; }
  get(id: number): SoldierRecord | undefined { const r = this.records.get(id); return r && { ...r }; }
  list(): SoldierRecord[] { return [...this.records.values()].map(r => ({ ...r })); }

  create(fields: Partial<Omit<SoldierRecord, 'id'>> = {}): SoldierRecord {
    const record = { id: this.nextId++, name: validName(fields.name) ? fields.name : randomName(this.rng), level: validLevel(fields.level) ? fields.level : 0 };
    this.records.set(record.id, record);
    return { ...record };
  }
  /** Applies valid fields; returns false for unknown soldiers or invalid values. */
  update(id: number, patch: Partial<Omit<SoldierRecord, 'id'>>) {
    const record = this.records.get(id);
    if (!record || (patch.name !== undefined && !validName(patch.name)) || (patch.level !== undefined && !validLevel(patch.level))) return false;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.level !== undefined) record.level = patch.level;
    return true;
  }
  delete(id: number) { return this.records.delete(id); }
  /** Replaces every soldier with `size` fresh level-0 recruits. */
  reset(size = ROSTER_SIZE) {
    this.records.clear();
    for (let i = 0; i < size; i++) this.create();
  }

  /**
   * `count` distinct soldiers in random order, so no one keeps the same formation slot
   * between battles. Recruits new soldiers when the pool is too small.
   */
  draft(count: number): SoldierRecord[] {
    while (this.records.size < count) this.create();
    const pool = [...this.records.values()];
    for (let n = 0; n < count; n++) {
      const picked = n + Math.floor(this.rng() * (pool.length - n));
      [pool[n], pool[picked]] = [pool[picked], pool[n]];
    }
    return pool.slice(0, count).map(r => ({ ...r }));
  }
  /** Survivors of a finished battle gain a level. */
  promote(ids: Iterable<number>) {
    for (const id of ids) { const record = this.records.get(id); if (record) record.level++; }
  }

  serialize() { return JSON.stringify({ nextId: this.nextId, soldiers: [...this.records.values()].map(r => [r.id, r.name, r.level]) }); }
  /** Restores a saved roster; returns false (leaving this one untouched) when the data is invalid. */
  restore(json: string | null) {
    try {
      const data = JSON.parse(json ?? 'null');
      if (!data || !Array.isArray(data.soldiers) || !Number.isInteger(data.nextId)) return false;
      const records = new Map<number, SoldierRecord>();
      for (const entry of data.soldiers) {
        const [id, name, level] = Array.isArray(entry) ? entry : [];
        if (!Number.isInteger(id) || id <= 0 || id >= data.nextId || records.has(id) || !validName(name) || !validLevel(level)) return false;
        records.set(id, { id, name, level });
      }
      this.records = records; this.nextId = data.nextId;
      return true;
    } catch { return false; }
  }
}

export function loadRoster(rng?: () => number) {
  const roster = new Roster(rng);
  if (!roster.restore(readSetting(SOLDIERS_KEY))) roster.reset();
  return roster;
}
export function saveRoster(roster: Roster) {
  try { writeSetting(SOLDIERS_KEY, roster.serialize()); } catch { /* Session-only roster. */ }
}

/**
 * Links one battle to the roster: the `team` soldiers present at deployment take drafted
 * records in slot order. Only the deployed soldiers have records; mid-battle spawns stay anonymous.
 */
export class BattleRoster {
  private readonly bySimId = new Map<number, SoldierRecord>();
  private recorded: boolean;
  private readonly roster: Roster;
  readonly sim: BattleSimulation;

  constructor(roster: Roster, sim: BattleSimulation, team: Team = 0) {
    this.roster = roster; this.sim = sim;
    // Attaching to a battle that already ended (e.g. after a roster reset) must not promote anyone.
    this.recorded = sim.result !== 'running';
    let deployed = 0;
    for (let i = 0; i < sim.used; i++) if (sim.team[i] === team) deployed++;
    const drafted = roster.draft(deployed);
    for (let i = 0, k = 0; i < sim.used; i++) if (sim.team[i] === team) this.bySimId.set(sim.id[i], drafted[k++]);
  }

  /** The record of a soldier in this battle, by simulation id. */
  soldier(simId: number) { return this.bySimId.get(simId); }
  /** Records of soldiers still alive, with their simulation ids. */
  living() {
    const living: { simId: number; record: SoldierRecord }[] = [];
    for (const [simId, record] of this.bySimId) {
      const i = this.sim.byId.get(simId);
      if (i !== undefined && this.sim.hp[i] > 0) living.push({ simId, record });
    }
    return living;
  }
  /** Once the battle ends, promotes survivors exactly once. Returns true when it did. */
  recordOutcome() {
    if (this.recorded || this.sim.result === 'running') return false;
    this.recorded = true;
    const survivors = this.living();
    this.roster.promote(survivors.map(s => s.record.id));
    for (const s of survivors) s.record.level++;
    return true;
  }
}
