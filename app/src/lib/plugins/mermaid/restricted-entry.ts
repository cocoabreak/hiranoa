import { renderMermaid } from "./renderer";

export const moduleUrl = import.meta.url;

// The parent imports the URL, then loads this module in the frame's own JS realm.
if (typeof window !== "undefined" && window.frameElement?.hasAttribute("data-mermaid-renderer")) {
  Object.assign(window, { renderRestrictedMermaid: renderMermaid });
}
