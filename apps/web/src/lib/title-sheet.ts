import type { useRouter } from "@tanstack/react-router";

/** Search param that opens a title in the phone sheet on top of the current page. */
export const SHEET_PARAM = "title";
const PHONE_QUERY = "(max-width: 767px)";

/**
 * Open a title on phones as a sheet over the current page (like the mobile app) instead of
 * navigating away from it. Returns false when the regular page should open instead.
 */
export function openTitleSheet(
  router: ReturnType<typeof useRouter>,
  id: string,
  event?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
): boolean {
  if (typeof window === "undefined" || !window.matchMedia(PHONE_QUERY).matches) return false;
  if (event && (event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0)) {
    return false;
  }
  const { pathname, search } = router.state.location;
  void router.navigate({
    to: pathname,
    search: { ...(search as Record<string, unknown>), [SHEET_PARAM]: id },
    // Keep the page behind where it was
    resetScroll: false,
  } as never);
  return true;
}
