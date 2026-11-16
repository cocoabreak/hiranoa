import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";

const CONTENT_SCOPE = ".markdown-body";

/** ユーザーCSSを検証し、アプリUIへ漏れないようコンテンツ領域へスコープする */
export async function prepareCustomCss(css: string): Promise<(scope?: string) => string> {
  const { default: selectorParser } = await import("postcss-selector-parser");
  const rejectUnsupported = {
    postcssPlugin: "reject-unsupported-custom-css",
    AtRule(atRule: { name: string; error: (message: string) => Error }) {
      if (atRule.name.toLowerCase() === "import") {
        throw atRule.error("@import はカスタムCSSで使用できません");
      }
    },
    Declaration(declaration: { value: string; error: (message: string) => Error }) {
      if (/url\s*\(/i.test(declaration.value)) {
        throw declaration.error("url() はカスタムCSSで使用できません");
      }
    },
  };

  const validated = await postcss([rejectUnsupported]).process(css, { from: undefined });
  const selectors = new Map<string, ReturnType<ReturnType<typeof selectorParser>["astSync"]>>();
  validated.root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    selectors.set(rule.selector, selectorParser().astSync(rule.selector));
  });
  return (scope?: string) => {
    const prefix = scope ? `[data-view-scope="${scope}"]` : CONTENT_SCOPE;
    const root = validated.root.clone();
    if (scope)
      root.walkRules((rule) => {
        const parsed = selectors.get(rule.selector)?.clone();
        if (!parsed) return;
        parsed.walkIds((id) => {
          id.setPropertyAndEscape(
            "value",
            `view-${scope}-${id.value}`,
            `view-${scope}-${(id as typeof id & { raws?: { value?: string } }).raws?.value ?? id.value}`
          );
        });
        parsed.walkAttributes((attribute) => {
          if (attribute.attribute.toLowerCase() === "id")
            attribute.setPropertyWithoutEscape("attribute", "data-logical-id");
        });
        rule.selector = parsed.toString();
      });
    return postcss([
      prefixSelector({
        prefix,
        transform(prefix, selector, prefixedSelector) {
          const trimmed = selector.trim();
          if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) return selector;
          if (
            trimmed === ":root" ||
            trimmed === "html" ||
            trimmed === "body" ||
            trimmed === CONTENT_SCOPE
          )
            return prefix;
          if (scope && trimmed.startsWith(`${CONTENT_SCOPE} `))
            return prefix + trimmed.slice(CONTENT_SCOPE.length);
          return prefixedSelector;
        },
      }),
    ]).process(root, { from: undefined }).css;
  };
}

export async function scopeCustomCss(css: string): Promise<string> {
  return (await prepareCustomCss(css))();
}
