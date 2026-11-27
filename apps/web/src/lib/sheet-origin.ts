/**
 * Phones: titles open as a sheet, and titles opened from inside it stack on top. Closing the
 * sheet goes straight back to the list you started from (not to the previous title), so we
 * remember where that list sits in the browser history.
 */
let originIndex: number | null = null;

interface WithState {
  pathname: string;
  state?: unknown;
}

const historyIndex = (location: WithState) =>
  (location.state as { __TSR_index?: number } | undefined)?.__TSR_index ?? null;

const isTitlePath = (pathname: string) => pathname.startsWith("/titles/");

/** Call before every navigation. */
export function trackSheetOrigin(from: WithState | undefined, to: WithState) {
  if (!isTitlePath(to.pathname)) return;
  if (!from || !isTitlePath(from.pathname)) originIndex = from ? historyIndex(from) : null;
}

/** How many steps back the list is from `current`, or null if unknown. */
export function stepsBackToOrigin(current: WithState) {
  const now = historyIndex(current);
  if (originIndex == null || now == null || now <= originIndex) return null;
  return now - originIndex;
}
