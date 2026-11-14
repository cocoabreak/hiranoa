import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/svelte";

expect.extend(matchers);

// globals: false のため @testing-library/svelte の自動cleanupが効かない。
// テストごとに明示的にDOMを片付ける。
afterEach(() => {
  cleanup();
});
