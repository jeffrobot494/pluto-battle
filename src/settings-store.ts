/**
 * Synchronous settings cache. Browser storage is unavailable inside the RUN iframe, so
 * `rundot-storage.ts` fills this cache from RUN app storage before the game starts and
 * installs a writer that persists changes back. Without a writer (Node tests), values
 * live in memory for the session.
 */
const cache = new Map<string, string>();
let persist: ((key: string, value: string) => void) | undefined;

export function readSetting(key: string): string | null { return cache.get(key) ?? null; }
export function writeSetting(key: string, value: string) {
  cache.set(key, value);
  persist?.(key, value);
}
export function installSettingsStore(values: Record<string, string | null>, writer: (key: string, value: string) => void) {
  for (const [key, value] of Object.entries(values)) if (typeof value === 'string') cache.set(key, value);
  persist = writer;
}
