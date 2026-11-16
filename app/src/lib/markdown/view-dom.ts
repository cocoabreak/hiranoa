const logicalIds = new WeakMap<Element, string>();
export interface ViewIdMapping {
  get(id: string): string | undefined;
  has(id: string): boolean;
}
const styleMappers = new WeakMap<Element, (mapping: ViewIdMapping) => void>();

export function registerViewStyleMapper(
  style: Element,
  mapper: (mapping: ViewIdMapping) => void
): void {
  styleMappers.set(style, mapper);
}

export function logicalElementId(element: Element): string {
  return logicalIds.get(element) ?? element.id;
}

/** Canonical anchors remain available for navigation, reference copy, and user CSS. */
export function namespaceViewDom(root: HTMLElement, scope: string): void {
  const logicalMapping = new Map<string, string>();
  const counts = new Map<string, number>();
  const elements = [...root.querySelectorAll("[id]")];
  const previousIds = new Map(elements.map((element) => [element, element.id]));
  const reserved = new Set(elements.map((element) => `${scope}-${logicalElementId(element)}`));
  const used = new Set<string>();
  for (const element of elements) {
    const logical = logicalElementId(element);
    logicalIds.set(element, logical);
    element.setAttribute("data-logical-id", logical);
    let count = counts.get(logical) ?? 0;
    let id = `${scope}-${logical}`;
    if (count) {
      id = `${scope}-${logical}--duplicate-${count}`;
      while (used.has(id) || reserved.has(id)) {
        count++;
        id = `${scope}-${logical}--duplicate-${count}`;
      }
    }
    counts.set(logical, count + 1);
    used.add(id);
    if (!logicalMapping.has(logical)) logicalMapping.set(logical, id);
    element.id = id;
  }
  const mapping = new Map<string, string>();
  const svgMappings = new Map<Element, Map<string, string>>();
  const svgOwners = new Map<Element, Element>();
  // Index each ID once. Local maps never copy the whole document's ID set.
  for (const element of elements) {
    const previous = previousIds.get(element)!;
    if (!mapping.has(previous)) mapping.set(previous, element.id);
    const svg = element.closest("svg");
    if (!svg) continue;
    let local = svgMappings.get(svg);
    if (!local) {
      local = new Map();
      svgMappings.set(svg, local);
    }
    if (!local.has(previous)) local.set(previous, element.id);
    svgOwners.set(element, svg);
  }
  // Already-rewritten references use the previous DOM namespace. Reserve every
  // previous key before adding canonical fallbacks; either namespace may contain
  // text that resembles the other one.
  for (const [logical, actual] of logicalMapping) {
    if (!mapping.has(logical)) mapping.set(logical, actual);
  }
  for (const element of elements) {
    const svg = svgOwners.get(element);
    if (!svg) continue;
    const local = svgMappings.get(svg)!;
    const logical = logicalElementId(element);
    if (!local.has(logical)) local.set(logical, element.id);
  }
  const overlays = new Map<Element, ViewIdMapping>();
  function mappingFor(element: Element): ViewIdMapping {
    const svg = element.closest("svg");
    if (!svg) return mapping;
    let overlay = overlays.get(svg);
    if (!overlay) {
      const get = (id: string): string | undefined => {
        let current: Element | null = svg;
        while (current) {
          const actual = svgMappings.get(current)?.get(id);
          if (actual !== undefined) return actual;
          current = current.parentElement?.closest("svg") ?? null;
        }
        return mapping.get(id);
      };
      overlay = { get, has: (id) => get(id) !== undefined };
      overlays.set(svg, overlay);
    }
    return overlay;
  }
  for (const element of root.querySelectorAll("*")) {
    const references = mappingFor(element);
    for (const attribute of [...element.attributes]) {
      if (["href", "xlink:href"].includes(attribute.name) && attribute.value.startsWith("#")) {
        // Keep link anchors canonical; click navigation is scoped to this root.
        if (element.tagName.toLowerCase() === "a") continue;
        const id = references.get(attribute.value.slice(1));
        if (id) element.setAttribute(attribute.name, `#${id}`);
      } else if (["for", "aria-labelledby", "aria-describedby"].includes(attribute.name)) {
        element.setAttribute(
          attribute.name,
          attribute.value
            .split(/\s+/)
            .map((id) => references.get(id) ?? id)
            .join(" ")
        );
      } else if (attribute.name !== "id" && attribute.name !== "data-logical-id") {
        const value = attribute.value.replace(
          /url\(["']?#([^\s)'"]+)["']?\)/g,
          (match, id: string) => (references.has(id) ? `url(#${references.get(id)})` : match)
        );
        if (value !== attribute.value) element.setAttribute(attribute.name, value);
      }
    }
    styleMappers.get(element)?.(references);
  }
}
