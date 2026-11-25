import type { Snippet } from "svelte";
import { SvelteMap } from "svelte/reactivity";

// The viewer owns the selection and ranges. The right panel renders only
// the active viewer's list, including when two panes show the same document.
export const annotationViews = new SvelteMap<
  string,
  {
    list: Snippet<[onNavigate: () => void]>;
    readonly count: number;
    readonly hasMatch: boolean;
  }
>();
