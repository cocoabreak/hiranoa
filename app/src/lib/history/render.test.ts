import { describe, expect, it } from "vitest";
import { protectHistoryResources } from "./render";
import { protectExternalImages } from "$lib/markdown/external-images";

describe("history resource isolation", () => {
  it("removes live sources before insertion and returns only local image requests", () => {
    const result = protectHistoryResources(
      '<p><img src="../images/old.png"><img src="https://example.com/private.png" srcset="live.png 2x"><img src="file:///private.png"></p><a href="other.md">other</a><a href="#heading">jump</a>'
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;
    expect(template.content.querySelector("[src], [srcset]")).toBeNull();
    expect(result.images.map((i) => i.target)).toEqual(["../images/old.png"]);
    expect(template.content.querySelector('a[href="other.md"]')).toBeNull();
    expect(template.content.querySelector('a[href="#heading"]')).not.toBeNull();
  });
  it("blocks relative diagram assets while preserving internal svg references", () => {
    const result = protectExternalImages(
      '<svg><image href="old.png"/><use href="#symbol"/><image href="https://example.com/a.png"/></svg>',
      true
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;
    expect(template.content.querySelector("image[href]")).toBeNull();
    expect(template.content.querySelector('use[href="#symbol"]')).not.toBeNull();
    expect(result.blockedCount).toBe(2);
  });
  it("keeps image-map anchors in the comparison and removes other browser destinations", () => {
    const result = protectHistoryResources(
      '<map><area href="other.md"><area href="#heading"></map><svg><a xlink:href="other.md"><rect/></a></svg>'
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;
    expect(template.content.querySelector("area")?.hasAttribute("href")).toBe(false);
    expect(template.content.querySelector('area[href="#heading"]')).not.toBeNull();
    expect(template.content.querySelector("svg a")?.hasAttribute("xlink:href")).toBe(false);
  });
});
