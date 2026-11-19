export const PREVIEW_LINK_SELECTOR = "a, area";

/** Leave link activation to the preview, including links without a supported destination. */
export function interceptPreviewLink(event: MouseEvent): string | null {
  if (!(event.target instanceof Element)) return null;
  const link = event.target.closest(PREVIEW_LINK_SELECTOR);
  if (!link) return null;
  event.preventDefault();
  return link.getAttribute("href");
}
