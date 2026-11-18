import { invoke } from "@tauri-apps/api/core";
import { createMarkdownRenderSession, type RenderOptions } from "$lib/markdown/engine";
import { protectExternalImages } from "$lib/markdown/external-images";
import { buildToc, scrollToAnchor } from "$lib/markdown/toc-dom";
import { namespaceViewDom } from "$lib/markdown/view-dom";
import { viewerPlugins } from "$lib/plugins";
import type { Locale } from "$lib/i18n/index.svelte";
import type { MarkdownBlock } from "./compare";

/** Protect every resource before insertion; history never falls back to live images. */
export function protectHistoryResources(html: string): {
  html: string;
  images: { id: string; target: string }[];
} {
  const template = document.createElement("template");
  template.innerHTML = protectExternalImages(html).html;
  for (const anchor of template.content.querySelectorAll("a[href]")) {
    if (!anchor.getAttribute("href")?.startsWith("#")) anchor.removeAttribute("href");
  }
  const images: { id: string; target: string }[] = [];
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img")) {
    const target = image.getAttribute("src");
    image.removeAttribute("src");
    image.removeAttribute("srcset");
    if (!target || /^data:|^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(target) || images.length >= 100)
      continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      continue;
    }
    const id = crypto.randomUUID();
    image.dataset.historyImage = id;
    images.push({ id, target: decoded });
  }
  for (const element of template.content.querySelectorAll(
    "[src], [srcset], [poster], image[href], image[xlink\\:href], use[href], use[xlink\\:href]"
  )) {
    for (const attribute of ["src", "srcset", "poster", "href", "xlink:href"])
      element.removeAttribute(attribute);
  }
  // History is a self-contained preview; CSS resource loading is never needed here.
  for (const element of template.content.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") ?? "";
    if (/\\|url|image-set/i.test(style)) element.removeAttribute("style");
  }
  return { html: template.innerHTML, images };
}

export function createHistoryRenderer() {
  const renderSession = createMarkdownRenderSession();
  let generation = 0;
  let cleanup: (() => void)[] = [];
  const clear = () => {
    generation++;
    renderSession.cancel();
    cleanup.forEach((fn) => fn());
    cleanup = [];
  };
  async function render(
    root: HTMLElement,
    raw: string,
    blocks: MarkdownBlock[],
    sessionId: string,
    revision: string,
    options: RenderOptions,
    locale: Locale
  ): Promise<Map<number, HTMLElement>> {
    clear();
    const current = generation;
    const result = await renderSession.render(raw, options);
    if (current !== generation) return new Map();
    const protectedHtml = protectHistoryResources(result.html);
    root.innerHTML = protectedHtml.html;
    const prefix = blocks[0]?.kind === "frontmatter" ? blocks[0].end : 0;
    if (prefix) {
      const metadata = document.createElement("pre");
      metadata.className = "history-frontmatter";
      metadata.textContent = blocks[0].raw;
      root.prepend(metadata);
    }
    const elements = [...root.children] as HTMLElement[];
    const mapped = new Map<number, HTMLElement>();
    let cursor = 0;
    blocks.forEach((block, index) => {
      if (block.kind === "frontmatter") {
        mapped.set(index, elements[cursor++]);
        return;
      }
      const line = block.start - prefix + 1;
      const exact = root.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
      if (block.kind === "definition") {
        const definition = document.createElement("pre");
        definition.className = "history-definition";
        definition.textContent = block.raw;
        root.append(definition);
        mapped.set(index, definition);
        return;
      }
      const element = exact ?? elements[cursor];
      if (element) {
        mapped.set(index, element);
        cursor = Math.max(cursor, elements.indexOf(element) + 1);
      }
    });
    buildToc(root);
    const scope = `history-${crypto.randomUUID()}`;
    root.dataset.viewScope = scope;
    namespaceViewDom(root, `view-${scope}`);
    root.querySelectorAll<HTMLInputElement>("input").forEach((input) => (input.disabled = true));
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (href?.startsWith("#")) scrollToAnchor(root, href.slice(1));
    };
    root.addEventListener("click", click);
    cleanup.push(() => root.removeEventListener("click", click));
    for (const plugin of viewerPlugins) {
      if (!plugin.postRender) continue;
      try {
        const dispose = plugin.postRender(root, {
          document: null,
          source: null,
          filePath: null,
          rootPath: null,
          respectGitignore: true,
          locale,
          externalImagesAllowed: false,
          blockLocalResources: true,
        });
        if (dispose) cleanup.push(dispose);
      } catch (error) {
        console.warn("History post-render failed", error);
      }
    }
    let nextImage = 0;
    async function imageWorker() {
      while (current === generation) {
        const image = protectedHtml.images[nextImage++];
        if (!image) return;
        try {
          const data = await invoke<string>("read_git_image", {
            sessionId,
            revision,
            target: image.target,
          });
          if (current !== generation) return;
          const element = root.querySelector<HTMLImageElement>(
            `img[data-history-image="${image.id}"]`
          );
          if (element) element.src = data;
        } catch {
          /* Missing or denied assets remain visibly unavailable. */
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, protectedHtml.images.length) }, imageWorker));
    return mapped;
  }
  return { render, clear };
}
