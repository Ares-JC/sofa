/**
 * Phones: titles open as a sheet on their own page, so the list you came from is gone behind
 * it. Just before opening one, we keep a still copy of that page (it looks the same, but it's
 * only a picture: nothing on it can be tapped) and show it behind the sheet, so pulling the
 * sheet down shows where you were. Closing the sheet goes back to the real page.
 */
let snapshot: {
  node: HTMLElement;
  top: number;
  left: number;
  width: number;
  /** Bottom of the top bar: the copy is cut there, like the real page under the bar. */
  clipTop: number;
} | null = null;

const PHONE_QUERY = "(max-width: 767px)";

/** Keep a copy of the page on screen right now (call just before opening a title). */
export function capturePageSnapshot() {
  try {
    if (!window.matchMedia(PHONE_QUERY).matches) return;
    // Opening another title from inside the sheet keeps the original page behind it
    if (document.querySelector("[data-mobile-sheet]")) return;
    const main = document.getElementById("main-content");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const node = main.cloneNode(true) as HTMLElement;
    node.removeAttribute("id");
    for (const el of node.querySelectorAll("[id]")) el.removeAttribute("id");
    const clipTop = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    snapshot = { node, top: rect.top, left: rect.left, width: rect.width, clipTop };
  } catch {
    snapshot = null;
  }
}

/**
 * Put the saved copy inside `container` (behind the sheet) and forget it, so it's only used
 * once. Returns false if there's none.
 */
export function mountPageSnapshot(container: HTMLElement) {
  if (!snapshot) return false;
  const { node, top, left, width, clipTop } = snapshot;
  snapshot = null;
  const clip = document.createElement("div");
  clip.style.position = "absolute";
  clip.style.inset = `${clipTop}px 0 0 0`;
  clip.style.overflow = "hidden";
  node.style.position = "absolute";
  node.style.top = `${top - clipTop}px`;
  node.style.left = `${left}px`;
  node.style.width = `${width}px`;
  node.style.margin = "0";
  node.style.pointerEvents = "none";
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("inert", "");
  clip.append(node);
  container.replaceChildren(clip);
  return true;
}
