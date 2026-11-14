import { describe, expect, it } from "vitest";
import deepmerge from "../vendor/deepmerge/index.cjs";

const attack = () => JSON.parse('{"__proto__":{"attackerMarker":true}}');

describe("build configuration merge safety", () => {
  it("targetの危険なキーをコピーしても返却値のprototypeを変更しない", () => {
    const result = deepmerge(attack(), { safe: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).not.toHaveProperty("attackerMarker");
    expect(result.safe).toBe(true);
  });

  it("null prototypeのtargetとsourceをマージしてもprototypeを変更しない", () => {
    const result = deepmerge(Object.create(null), attack());
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).not.toHaveProperty("attackerMarker");
  });

  it("入れ子と配列内の攻撃入力も返却値のprototypeを変更しない", () => {
    const result = deepmerge({ nested: attack(), items: [attack()] }, {});
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
    expect(result.nested).not.toHaveProperty("attackerMarker");
    expect(Object.getPrototypeOf(result.items[0])).toBe(Object.prototype);
    expect(result.items[0]).not.toHaveProperty("attackerMarker");
    expect({}).not.toHaveProperty("attackerMarker");
  });

  it("通常の設定マージと配列の上書きオプションを維持する", () => {
    expect(deepmerge({ nested: { a: 1 }, items: [1] }, { nested: { b: 2 }, items: [2] })).toEqual({
      nested: { a: 1, b: 2 },
      items: [1, 2],
    });
    expect(
      deepmerge({ items: [1] }, { items: [2] }, { arrayMerge: (_target, source) => source })
    ).toEqual({
      items: [2],
    });
  });
});
