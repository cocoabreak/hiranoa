import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { settingsStore, type ExternalImagePolicy } from "$lib/stores/settings.svelte";
import {
  approveExternalImagesForDocument,
  clearExternalImageApprovals,
} from "$lib/stores/external-image-permission";
import { MAX_PNG_DIMENSION, saveAsHtml, saveAsSvg, validatePngDimensions } from "./export-actions";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(true);
  settingsStore.setExternalImagePolicy("ask");
  clearExternalImageApprovals();
});

describe("native export commands", () => {
  it("HTML内容だけをRustへ渡し、保存先パスをWebViewで扱わない", async () => {
    await saveAsHtml(
      { title: '</title><script>alert("x")</script>', path: "notes.md" },
      "<h1>safe</h1>"
    );

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("save_text_export", {
      format: "html",
      suggestedName: '</title><script>alert("x")</script>',
      contents: expect.stringContaining(
        "<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>"
      ),
    });
    const contents = (mockedInvoke.mock.calls[0][1] as Record<string, unknown>).contents as string;
    expect(contents).not.toContain("Hiranoa Local");
    expect(contents).not.toContain("local-fonts");
    expect(contents).toContain(".markdown-body .callout");
    expect(contents).toContain("details.callout:not([open]) > :not(summary)");
  });

  it.each<[ExternalImagePolicy, string, string]>([
    ["block", "approved.md", "data:"],
    ["ask", "approved.md", "data: https:"],
    ["ask", "another.md", "data:"],
    ["allow", "another.md", "data: https:"],
  ])("uses %s for %s when saving HTML", async (policy, path, expectedSources) => {
    settingsStore.setExternalImagePolicy(policy);
    approveExternalImagesForDocument("approved.md");
    await saveAsHtml({ title: "Notes", path }, "<h1>Notes</h1>");

    const { contents } = mockedInvoke.mock.calls[0][1] as { contents: string };
    const html = new DOMParser().parseFromString(contents, "text/html");
    const csp = html.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(csp?.getAttribute("content")?.split("; ")).toEqual([
      "default-src 'none'",
      `img-src ${expectedSources}`,
      "media-src 'none'",
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    expect(csp?.nextElementSibling?.getAttribute("name")).toBe("viewport");
    expect(html.querySelector("h1")?.id).toBe("notes");
  });

  it("retains image and document markup while disabling media sources and resource hints", async () => {
    const image = "https://example.invalid/image.png";
    const media = "https://example.invalid/sample.mp4";
    await saveAsHtml(
      { title: "Notes", path: "notes.md" },
      `<link rel="preload" as="video" href="${media}">` +
        `<video src="${media}" poster="${image}"><source src="${media}"></video>` +
        `<picture><source srcset="${image}"><img src="${image}" alt="Sample"></picture>` +
        `<a href="#notes" style="color: red" ping="${media}">Jump</a><h1>Notes</h1>`
    );

    const { contents } = mockedInvoke.mock.calls[0][1] as { contents: string };
    const html = new DOMParser().parseFromString(contents, "text/html");
    expect(html.querySelector("link, video[src], video source, [ping]")).toBeNull();
    expect(html.querySelector("video")?.getAttribute("poster")).toBe(image);
    expect(html.querySelector("picture source")?.getAttribute("srcset")).toBe(image);
    expect(html.querySelector("a")?.getAttribute("href")).toBe("#notes");
    expect(html.querySelector("a")?.style.color).toBe("red");
  });

  it("SVGをネイティブ保存コマンドへ渡す", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    await saveAsSvg(svg, "diagram");

    expect(mockedInvoke).toHaveBeenCalledWith("save_text_export", {
      format: "svg",
      suggestedName: "diagram",
      contents: expect.stringContaining('xmlns="http://www.w3.org/2000/svg"'),
    });
  });

  it("PNG Canvasの次元と総画素数を生成前に制限する", () => {
    expect(() => validatePngDimensions(1, 1)).not.toThrow();
    expect(() => validatePngDimensions(MAX_PNG_DIMENSION + 1, 1)).toThrow();
    expect(() => validatePngDimensions(5_001, 5_000)).toThrow();
    expect(() => validatePngDimensions(Number.NaN, 10)).toThrow();
  });
});
