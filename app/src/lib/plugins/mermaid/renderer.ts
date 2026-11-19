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
        ],
        suppressErrorRendering: true,
      });
      return mermaid;
    })
    .catch((error) => {
      engine = undefined;
      throw error;
    });
  const mermaid = await engine;
  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(`i${id}`)?.remove();
  }
}
