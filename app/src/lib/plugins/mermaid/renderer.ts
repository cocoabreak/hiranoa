import { DOCUMENT_TOP_LAYER_ATTRIBUTES } from "$lib/markdown/sanitize";

let engine: Promise<typeof import("mermaid").default> | undefined;

export async function renderMermaid(id: string, code: string): Promise<string> {
  engine ??= import("mermaid")
    .then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "maxEdges",
          "suppressErrorRendering",
          "themeCSS",
          "themeVariables",
          "fontFamily",
          "dompurifyConfig",
        ],
        dompurifyConfig: {
          FORBID_TAGS: ["style"],
          FORBID_ATTR: DOCUMENT_TOP_LAYER_ATTRIBUTES,
        },
        suppressErrorRendering: true,
      });
      return mermaid;
    })
    .catch((error) => {
      engine = undefined;
      throw error;
    });
  const mermaid = await engine;
  // Keep Mermaid's temporary measurement DOM invisible even when it runs in the app document.
  const host = document.createElement("div");
  host.id = `${id}-render-host`;
  host.inert = true;
  host.style.cssText = "position:fixed;inset:0;opacity:0;contain:paint";
  document.body.append(host);
  try {
    return (await mermaid.render(id, code, host)).svg;
  } finally {
    host.remove();
  }
}
