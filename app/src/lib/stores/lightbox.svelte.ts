type LightboxContent = { type: "image"; src: string; alt: string } | { type: "svg"; html: string };

function createLightboxStore() {
  let originRoot: Element | null = null;
  let content = $state<LightboxContent | null>(null);

  return {
    get content() {
      return content;
    },
    get open() {
      return content !== null;
    },
    openImage(src: string, alt: string, origin?: Element) {
      originRoot = origin?.closest(".markdown-body") ?? null;
      content = { type: "image", src, alt };
    },
    openSvg(html: string, origin?: Element) {
      originRoot = origin?.closest(".markdown-body") ?? null;
      content = { type: "svg", html };
    },
    closeFrom(root: Element) {
      if (originRoot === root) {
        content = null;
        originRoot = null;
      }
    },
    close() {
      originRoot = null;
      content = null;
    },
  };
}

export const lightboxStore = createLightboxStore();
