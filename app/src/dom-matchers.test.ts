import { expect, expectTypeOf, it } from "vitest";

it("DOMマッチャーを同期・非同期のassertionと型に登録する", async () => {
  const element = document.createElement("div");
  element.setAttribute("aria-label", "a readable name");
  document.body.append(element);
  try {
    expectTypeOf(expect(element).toBeInTheDocument()).toEqualTypeOf<void>();
    const assertion = expect(Promise.resolve(element)).resolves.toBeInTheDocument();
    expectTypeOf(assertion).toEqualTypeOf<Promise<void>>();
    await assertion;
    expect(element).toHaveAccessibleName(expect.stringContaining("readable"));
  } finally {
    element.remove();
  }
});
