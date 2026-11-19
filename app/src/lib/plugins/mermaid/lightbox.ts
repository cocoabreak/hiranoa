import { createExpandButton } from "$lib/markdown/image-lightbox-trigger";
import { PREVIEW_LINK_SELECTOR } from "$lib/markdown/preview-links";
import { lightboxStore } from "$lib/stores/lightbox.svelte";

export function addMermaidExpandButton(mermaidEl: HTMLElement): void {
  const svg = mermaidEl.querySelector("svg");
  if (!svg) return;
  mermaidEl.appendChild(
    createExpandButton(() => {
      const display = svg.cloneNode(true) as SVGSVGElement;
      // Remove link destinations before inserting the copy into the lightbox.
      for (const link of display.querySelectorAll(PREVIEW_LINK_SELECTOR)) {
        link.removeAttribute("href");
        link.removeAttribute("xlink:href");
        link.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        link.removeAttribute("tabindex");
      }
      lightboxStore.openSvg(display.outerHTML, svg);
    })
  );
}
