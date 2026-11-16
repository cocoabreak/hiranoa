import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { namespaceViewDom, registerViewStyleMapper } from "./view-dom";

function escapedId(value: string): string {
  return [...value]
    .map((char) => (/[a-zA-Z0-9_-]/.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `))
    .join("");
}

/** Renderer styles retain parsed selectors across later whole-view ID changes. */
export function namespaceGeneratedSvg(
  root: HTMLElement,
  scope: string,
  viewRoot = root.closest<HTMLElement>(".markdown-body") ?? root
): void {
  for (const style of root.querySelectorAll("style")) {
    const css = postcss.parse(style.textContent ?? "");
    const selectors = new Map<
      postcss.Rule,
      ReturnType<ReturnType<typeof selectorParser>["astSync"]>
    >();
    css.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
      selectors.set(rule, selectorParser().astSync(rule.selector));
    });
    registerViewStyleMapper(style, (mapping) => {
      let changed = false;
      for (const [rule, parsed] of selectors) {
        parsed.walkIds((id) => {
          const actual = mapping.get(id.value);
          if (!actual || actual === id.value) return;
          id.setPropertyAndEscape("value", actual, escapedId(actual));
          changed = true;
        });
        rule.selector = parsed.toString();
      }
      css.walkDecls((declaration) => {
        const previous = declaration.value;
        declaration.value = previous.replace(
          /url\(["']?#([^\s)'"]+)["']?\)/g,
          (match, id: string) => (mapping.has(id) ? `url(#${mapping.get(id)})` : match)
        );
        changed ||= previous !== declaration.value;
      });
      if (changed) style.textContent = css.toString();
    });
  }
  namespaceViewDom(viewRoot, scope);
}
