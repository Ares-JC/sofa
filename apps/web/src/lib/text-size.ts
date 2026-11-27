/**
 * Text size chosen in Settings (per browser). Everything in Sofa is sized relative to the page's
 * base font size, so changing it scales text, spacing and buttons together, like a zoom, and the
 * layout keeps its proportions.
 */
export type TextSize = "small" | "normal" | "large" | "xlarge";

export const TEXT_SIZES: Record<TextSize, number> = {
  small: 15,
  normal: 16.5,
  large: 18,
  xlarge: 19.5,
};

const STORAGE_KEY = "sofa:text-size";

export function getTextSize(): TextSize {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in TEXT_SIZES) return saved as TextSize;
  } catch {
    // Storage blocked (private mode…): use the default
  }
  return "normal";
}

export function applyTextSize(size: TextSize = getTextSize()) {
  document.documentElement.style.fontSize = `${TEXT_SIZES[size]}px`;
}

export function setTextSize(size: TextSize) {
  try {
    localStorage.setItem(STORAGE_KEY, size);
  } catch {
    // Still applies for this visit
  }
  applyTextSize(size);
}
