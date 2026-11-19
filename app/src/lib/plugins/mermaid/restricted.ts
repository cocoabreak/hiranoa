import type { renderMermaid } from "./renderer";

type Renderer = typeof renderMermaid;
let renderer: Promise<Renderer> | undefined;

export function getRestrictedRenderer(): Promise<Renderer> {
  renderer ??= loadRenderer().catch((error) => {
    renderer = undefined;
    throw error;
  });
  return renderer;
}

async function loadRenderer(): Promise<Renderer> {
  const { moduleUrl } = await import("./restricted-entry");
  const frame = document.createElement("iframe");
  frame.dataset.mermaidRenderer = "";
  frame.sandbox.add("allow-same-origin", "allow-scripts");
  frame.title = "Mermaid renderer";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1024px;height:768px;visibility:hidden";
  // The frame owns both the DOM used for SVG layout and Mermaid's global Image constructor.
  frame.srcdoc = `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self' data:; base-uri 'none'; form-action 'none'">
    <body></body>`;

  try {
    return await new Promise<Renderer>((resolve, reject) => {
      const failed = () => {
        clearTimeout(timer);
        reject(new Error("Could not start the restricted Mermaid renderer"));
      };
      const timer = setTimeout(failed, 8000);
      frame.addEventListener(
        "load",
        () => {
          const frameDocument = frame.contentDocument;
          if (!frameDocument || frameDocument.URL !== "about:srcdoc") return failed();
          const script = frameDocument.createElement("script");
          script.type = "module";
          script.src = moduleUrl;
          script.onerror = failed;
          script.onload = () => {
            const child = frame.contentWindow as
              (Window & { renderRestrictedMermaid?: Renderer }) | null;
            const render = child?.renderRestrictedMermaid;
            if (typeof render !== "function") return failed();
            clearTimeout(timer);
            resolve(render);
          };
          frameDocument.head.append(script);
        },
        { once: true }
      );
      document.body.append(frame);
    });
  } catch (error) {
    frame.remove();
    throw error;
  }
}
