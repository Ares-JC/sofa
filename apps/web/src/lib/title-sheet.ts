/**
 * Phones open titles in a sheet over the current page (like the mobile app). The open title
 * lives in this small store rather than the URL, so opening it never navigates and the page
 * behind stays exactly as it was.
 */
const PHONE_QUERY = "(max-width: 767px)";

let openId: string | null = null;
const listeners = new Set<() => void>();

export function subscribeTitleSheet(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTitleSheetId() {
  return openId;
}

export function setTitleSheetId(id: string | null) {
  if (openId === id) return;
  openId = id;
  for (const listener of listeners) listener();
}

/** Open a title in the phone sheet. Returns false when the regular page should open instead. */
export function openTitleSheet(
  id: string,
  event?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
): boolean {
  if (typeof window === "undefined" || !window.matchMedia(PHONE_QUERY).matches) return false;
  if (event && (event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0)) {
    return false;
  }
  setTitleSheetId(id);
  return true;
}
