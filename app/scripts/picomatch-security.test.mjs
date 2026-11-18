import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const picomatch = require("picomatch");
const vendorEntry = fileURLToPath(new URL("../vendor/picomatch/index.js", import.meta.url));

test("all consumers resolve the local mitigation through both public entry points", () => {
  assert.equal(require("picomatch/package.json").version, "4.0.7-patch.1");
  assert.equal(picomatch, require(vendorEntry));
  assert.equal(require("picomatch/posix"), require("../vendor/picomatch/posix.js"));
  for (const consumer of ["vite", "vitest", "fdir", "tinyglobby", "@parcel/watcher"]) {
    const consumerRequire = createRequire(require.resolve(consumer));
    assert.equal(consumerRequire("picomatch"), picomatch, consumer);
  }
});

test("malicious repetitions terminate in a bounded child process across compilation APIs", () => {
  const child = String.raw`
    const assert = require('node:assert/strict');
    const pm = require(process.argv[1]);
    const patterns = ['+(*)', '*(*)', '+(*a)', '*(*a)', '+(a*)', '+(a+)', '+(*a|b)', '+(a{1,3})', '+(@(*a))', '+([[]*a)', '+(a\\*)', '+(a\\+)', '+(a\\|aa)', '+(a\\{1,3\\})', '+([a\\]*b])', '+(ab|abab)', '*(ab|abab)', '+(foo|foofoo)', '+([ab]|[ac])', '+(ab|ab)', '+(a?|?a)', '+(a[ab]|[ab]a)', '+(a|aa)', '+(a|A)', '+(abab|"ab")', '+(\\d|0)', '+([\\s\\S])Z', '**/+(*a).md'];
    const options = [{}, {maxExtglobRecursion:false}, {maxExtglobRecursion:0}, {fastpaths:false}, {windows:true}, {dot:true,capture:true}, {unescape:true}, {unescape:true,fastpaths:false}, {nocase:true}, {flags:'i'}];
    const inputs = ['a'.repeat(128)+'!', 'a'.repeat(128)+'!.md', '[a'.repeat(64)+'!', 'ab'.repeat(64)+'!', 'foo'.repeat(48)+'!', '0'.repeat(128)+'!', '[ a]'.repeat(32)+'!'];
    for (const pattern of patterns) for (const opts of options) {
      const match = pm(pattern, opts);
      const regex = pm.makeRe(pattern, opts);
      const parsed = pm.compileRe(pm.parse(pattern, opts), opts);
      for (const input of inputs) {
        assert.equal(match(input), false, pattern);
        assert.equal(regex.test(input), false, pattern);
        assert.equal(parsed.test(input), false, pattern);
      }
    }
    process.stdout.write('protected');
  `;
  const result = spawnSync(process.execPath, ["-e", child, vendorEntry], {
    timeout: 5000,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "protected");
});

test("risky patterns use the existing literal fallback", () => {
  for (const pattern of ["+(*)", "+(*a)", "+(a+)", "+(*a|b)"]) {
    assert.equal(picomatch.makeRe(pattern).test(pattern), true);
    assert.equal(picomatch(pattern)("aaaa"), false);
  }
});

test("ordinary globs, alternatives, fixed-width repetition and escaping keep their semantics", () => {
  const cases = [
    ["src/lib/example.test.ts", "src/**/*.{test,spec}.{js,ts}", true],
    ["src/lib/example.ts", "src/**/*.{test,spec}.{js,ts}", false],
    ["src/.hidden.ts", "src/**/*.ts", false],
    ["src/.hidden.ts", "src/**/*.ts", true, { dot: true }],
    ["src/node_modules/pkg/index.ts", "**/*.ts", false, { ignore: "**/node_modules/**" }],
    ["foo.ts", "@(foo|bar).ts", true],
    ["foofoo.ts", "+(foo|bar).ts", true],
    ["foo.ts", "!(*.test).ts", true],
    ["foo.test.ts", "!(*.test).ts", false],
    ["file123.md", "file+([0-9]).md", true],
    ["abac", "+(a?)", true],
    ["***", String.raw`+(\*)`, true],
    ["aaa", String.raw`+(\a)`, true, { unescape: true }],
    ["***", '+("*")', true],
    ["aaaa", "+(*(a))", true],
    ["abba", "+(*(a)|*(b))", true],
    ["src\\lib\\example.ts", "src/**/*.ts", true, { windows: true }],
  ];
  for (const [input, pattern, expected, opts] of cases)
    assert.equal(picomatch(pattern, opts)(input), expected, `${input} / ${pattern}`);
  assert.equal(picomatch.scan("src/**/*.ts").base, "src");
  assert.deepEqual(
    picomatch.makeRe("src/*/*.ts", { capture: true }).exec("src/lib/example.ts").slice(1),
    ["lib", "example"]
  );
});
