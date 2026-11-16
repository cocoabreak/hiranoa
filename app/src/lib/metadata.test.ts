import { describe, expect, it } from "vitest";
import {
  metadataDocument,
  metadataSources,
  matchesMetadata,
  normalizedSourceUrl,
  validateMetadataFields,
  displayMetadataValue,
  metadataKeys,
} from "./metadata";
import { parseFrontmatterYaml, extractFrontmatter } from "./markdown/frontmatter";

describe("shared frontmatter metadata", () => {
  it("bounds property suggestions by count and UTF-8 bytes while preserving manual lookup", () => {
    const documents = Array.from({ length: 4 }, (_, d) => ({
      path: `${d}.md`,
      title: "Title",
      description: "",
      invalid: false,
      data: Object.fromEntries(Array.from({ length: 510 }, (_, k) => [`key${d}_${k}`, "value"])),
    }));
    const keys = metadataKeys(documents);
    expect(keys.items).toHaveLength(200);
    expect(keys.partial).toBe(true);
    expect(
      matchesMetadata(documents[3], "", "", [
        { key: "key3_509", operator: "equals", value: "value" },
      ])
    ).toBe(true);
    const long = metadataKeys([
      {
        ...documents[0],
        data: Object.fromEntries(
          Array.from({ length: 200 }, (_, k) => [`${k}${"長".repeat(100)}`, 1])
        ),
      },
    ]);
    expect(long.partial).toBe(true);
    expect(long.items.length).toBeLessThan(200);
    expect(
      long.items.reduce((sum, key) => sum + new TextEncoder().encode(key).length, 0)
    ).toBeLessThanOrEqual(16 * 1024);
  });
  it("preserves dates and nested registration context without interpreting status", () => {
    const data = parseFrontmatterYaml(
      "review_status: unverified\nrecorded_on: 2026-11-13\nregistration_context:\n  projects:\n    - id: knowledge/projects/a\n      name: Project A\n  purpose: reuse\n"
    );
    expect(data.recorded_on).toBe("2026-11-13");
    expect(data.review_status).toBe("unverified");
    expect(data.registration_context).toEqual({
      projects: [{ id: "knowledge/projects/a", name: "Project A" }],
      purpose: "reuse",
    });
  });
  it("rejects aliases, recursion, excessive nesting, nodes and strings", () => {
    for (const yaml of [
      "a: &a [x]\nb: *a",
      "a: &a [*a]",
      `a: ${"[".repeat(12)}x${"]".repeat(12)}`,
      `a: [${Array(520).fill("x").join(",")}]`,
      `a: ${"x".repeat(2049)}`,
    ]) {
      expect(() => parseFrontmatterYaml(yaml)).toThrow();
      expect(extractFrontmatter(`---\n${yaml}\n---\n# Body`).invalid).toBe(true);
    }
  });
  it("uses title, H1 and filename fallback and exposes malformed YAML", () => {
    const candidate = {
      path: "notes/a.md",
      yaml: "description: Summary\ntags: [ok]",
      heading: "Heading",
      incomplete: false,
    };
    expect(metadataDocument(candidate).title).toBe("Heading");
    expect(metadataDocument({ ...candidate, yaml: "title: Title" }).title).toBe("Title");
    expect(metadataDocument({ ...candidate, yaml: null, heading: null }).title).toBe("a.md");
    expect(metadataDocument({ ...candidate, yaml: "x: [" }).invalid).toBe(true);
  });
  it("resolves document-relative sources, anchors and source boundary failures", () => {
    const document = metadataDocument({
      path: "silver/note.md",
      yaml: "sources:\n  - ../bronze/source.md#heading\n  - ../../outside.md\n  - https://example.com/page\n  - javascript:alert(1)\n  - C:/private/secret.md\n",
      heading: null,
      incomplete: false,
    });
    const sources = metadataSources(document, "s");
    expect(sources.map((source) => source.status)).toEqual([
      "unverifiable",
      "outsideSource",
      "external",
      "unsupported",
      "outsideSource",
    ]);
    expect(sources[0]).toMatchObject({
      path: "bronze/source.md",
      anchor: "heading",
      from: document.path,
    });
  });
  it("combines folder, free text, property presence and exact array element conditions", () => {
    const document = metadataDocument({
      path: "silver/note.md",
      yaml: "title: Open Knowledge\ntype: Knowledge\ntags: [okf, format]\nreview_status: unverified",
      heading: null,
      incomplete: false,
    });
    expect(
      matchesMetadata(document, "OPEN knowledge", "silver/", [
        { key: "tags", operator: "equals", value: "okf" },
        { key: "review_status", operator: "exists", value: "" },
      ])
    ).toBe(true);
    expect(matchesMetadata(document, "", "sil", [])).toBe(false);
    expect(
      matchesMetadata(document, "", "", [{ key: "tags", operator: "equals", value: "ok" }])
    ).toBe(false);
    expect(
      matchesMetadata(document, "", "", [{ key: "tags", operator: "contains", value: "ok" }])
    ).toBe(true);
    expect(
      matchesMetadata(document, "", "", [{ key: "toString", operator: "exists", value: "" }])
    ).toBe(false);
  });
  it("normalizes source URLs without dropping query distinctions", () => {
    expect(normalizedSourceUrl("HTTPS://EXAMPLE.COM:443/page/#fragment")).toBe(
      "https://example.com/page"
    );
    const document = metadataDocument({
      path: "a.md",
      yaml: "sources: [https://example.com/page/?a=1#section]",
      heading: null,
      incomplete: false,
    });
    expect(
      matchesMetadata(document, "", "", [
        { key: "sources", operator: "equals", value: "https://EXAMPLE.com/page?a=1" },
      ])
    ).toBe(true);
    expect(
      matchesMetadata(document, "", "", [
        { key: "sources", operator: "equals", value: "https://example.com/page?a=2" },
      ])
    ).toBe(false);
    expect(normalizedSourceUrl("https://user:password@example.com")).toBeNull();
  });
  it("validates user-configured labels and avoids inherited value mappings", () => {
    const [field] = validateMetadataFields([
      { key: "review_status", label: "確認", values: { unverified: "未確認" } },
    ]);
    expect(displayMetadataValue("unverified", field)).toBe("未確認");
    expect(displayMetadataValue("toString", field)).toBe("toString");
    expect(() =>
      validateMetadataFields([
        { key: "a", label: "", values: {} },
        { key: "a", label: "", values: {} },
      ])
    ).toThrow();
    expect(() => validateMetadataFields([{ key: "", label: "", values: {} }])).toThrow();
  });
});
