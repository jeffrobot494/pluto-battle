import { WEAPON_ID } from './config.ts';

// The item catalog references weapon definitions; army settings contain only allocation percentages.
export const ARMY_ITEMS = [
  { id: 'rifle', name: 'Laser rifle', weapon: WEAPON_ID.rifle, defaultPercent: 100 },
  { id: 'sniper', name: 'Sniper rifle', weapon: WEAPON_ID.sniper, defaultPercent: 0 },
  { id: 'shotgun', name: 'Shotgun', weapon: WEAPON_ID.shotgun, defaultPercent: 0 },
] as const;
export type ItemId = typeof ARMY_ITEMS[number]['id'];
export type ArmyEquipment = Record<ItemId, number>;
export type EquipmentSettings = [ArmyEquipment, ArmyEquipment];

export function defaultEquipment(): EquipmentSettings {
  const army = () => Object.fromEntries(ARMY_ITEMS.map(item => [item.id, item.defaultPercent])) as ArmyEquipment;
  return [army(), army()];
}
export function copyEquipment(values: EquipmentSettings): EquipmentSettings { return [{ ...values[0] }, { ...values[1] }]; }
export function validPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}
export function validateEquipment(values: unknown): values is EquipmentSettings {
  return Array.isArray(values) && values.length === 2 && values.every(army => army && ARMY_ITEMS.every(item => validPercentage(army[item.id])));
}
export function sameEquipment(a: EquipmentSettings, b: EquipmentSettings) {
  return ARMY_ITEMS.every(item => a[0][item.id] === b[0][item.id] && a[1][item.id] === b[1][item.id]);
}
export function recipientCount(count: number, percent: number) { return Math.round(count * percent / 100); }

const storageKey = 'pluto-battle-equipment-v1';
export function loadEquipment(): EquipmentSettings {
  const values = defaultEquipment();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    for (const team of [0, 1] as const) for (const item of ARMY_ITEMS) {
      if (validPercentage(saved?.[team]?.[item.id])) values[team][item.id] = saved[team][item.id];
    }
  } catch { /* Defaults also work when browser storage is unavailable. */ }
  return values;
}
export function saveEquipment(values: EquipmentSettings) {
  if (!validateEquipment(values)) return;
  try { localStorage.setItem(storageKey, JSON.stringify(values)); } catch { /* Session-only settings. */ }
}
