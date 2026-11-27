/**
 * Phones open titles in a sheet over the current page (like the mobile app). The open title
 * lives in this small store rather than the URL, so opening it never navigates and the page
 * behind stays exactly as it was.
 */
const PHONE_QUERY = "(max-width: 767px)";

let openId: string | null = null;
/** Title whose sheet actually mounted; used to fall back to the page if it never shows. */
let shownId: string | null = null;
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

/** Called by the sheet once it's on screen. */
export function markTitleSheetShown(id: string) {
  shownId = id;
}

/**
 * Open a title in the phone sheet. Returns false when the regular page should open instead.
 * If the sheet doesn't appear shortly after, `fallback` opens the regular page so a tap never
 * does nothing.
 */
export function openTitleSheet(
  id: string,
  event?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  fallback?: () => void,
): boolean {
  if (typeof window === "undefined" || !window.matchMedia(PHONE_QUERY).matches) return false;
  if (event && (event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0)) {
    return false;
  }
  shownId = null;
  setTitleSheetId(id);
  if (fallback) {
    setTimeout(() => {
      if (shownId !== id && openId === id) {
        setTitleSheetId(null);
        fallback();
      }
    }, 800);
  }
  return true;
}
