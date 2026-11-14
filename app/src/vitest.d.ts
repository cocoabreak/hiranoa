import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// jest-dom 7のVitest用Assertion拡張は旧形式のため、Vitest 5の公開Matchersへ登録する。
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type -- 上流の型をマージし、Vitestと同じ型パラメーターを維持する。
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
