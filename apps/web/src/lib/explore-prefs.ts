import { useSyncExternalStore } from "react";

/** Per-browser preference: hide titles already in the library from Explore lists. */
const STORAGE_KEY = "sofa:explore:hide-in-library";
const listeners = new Set<() => void>();
/** Fallback when localStorage is unavailable (private mode). */
let memoryValue: boolean | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setHideInLibrary(value: boolean) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the toggle still works until the page reloads.
    memoryValue = value;
  }
  for (const listener of listeners) listener();
}

export function useHideInLibrary(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => memoryValue ?? read(),
    () => false,
  );
}

/** Drop items that already have a library status when the preference is on. */
export function withoutLibraryTitles<T extends { id: string }>(
  items: T[],
  hide: boolean,
  statusOf: (item: T) => unknown,
): T[] {
  return hide ? items.filter((item) => !statusOf(item)) : items;
}

/**
 * Drop repeated titles from paged lists. TMDB pages can overlap when the ranking shifts between
 * page loads (e.g. a refetch after marking something watched), and React then shows the same
 * card several times.
 */
export function uniqueTitles<T extends { id: string; tmdbId?: number; type?: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id || `${item.type}-${item.tmdbId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
