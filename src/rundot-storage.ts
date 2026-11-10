import RundotGameAPI from '@series-inc/rundot-game-sdk/api';
import { installSettingsStore } from './settings-store.ts';

/** Keys of the player settings persisted in RUN app storage. */
export const SETTINGS_KEYS = ['pluto-battle-tuning-v1', 'pluto-battle-equipment-v1', 'pluto-battle.sound-volumes.v1'] as const;

async function loadAll() {
  const entries = await Promise.all(SETTINGS_KEYS.map(async key => [key, await RundotGameAPI.appStorage.getItem(key)] as const));
  return Object.fromEntries(entries);
}

// Settings must be available synchronously when main.ts starts, so this module blocks on
// one load. A slow or failing host falls back to defaults rather than stalling the game.
let loaded: Record<string, string | null> = {};
try {
  loaded = await Promise.race([loadAll(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))]);
} catch (error) { console.warn('Saved settings unavailable; using defaults', error); }

installSettingsStore(loaded, (key, value) => {
  RundotGameAPI.appStorage.setItem(key, value).catch(error => console.warn(`Setting ${key} not saved`, error));
});
