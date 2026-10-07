import assert from "node:assert/strict";
import test from "node:test";
import { exportCss } from "../public/js/core/export.mjs";

test("CP-14: initial palette export exactly matches fixed CSS bytes", () => {
  const actual = exportCss([
    { r: 17, g: 20, b: 16 },
    { r: 243, g: 240, b: 232 },
  ]);
  const expected = ":root {\n  --color-1: #111410;\n  --color-2: #F3F0E8;\n}\n";
  assert.equal(actual, expected);
  assert.deepStrictEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
  assert.equal(actual.endsWith("\n"), true);
  assert.equal(actual.includes("\r"), false);
  assert.equal(actual.charCodeAt(0), 0x3a);
});

test("export uses sequential variable names and fixed uppercase HEX for two through eight colors", () => {
  const colors = Array.from({ length: 8 }, (_, index) => ({ r: index, g: 16, b: 255 }));
  const css = exportCss(colors);
  assert.match(css, /--color-1: #0010FF;/);
  assert.match(css, /--color-8: #0710FF;/);
  assert.equal((css.match(/--color-/g) ?? []).length, 8);
  assert.equal(css.endsWith("}\n"), true);
  assert.throws(() => exportCss(colors.slice(0, 1)), RangeError);
});

test("export rejects malformed arrays and non-exact or invalid RGB records", () => {
  const valid = { r: 1, g: 2, b: 3 };
  for (const invalid of [
    null,
    {},
    [],
    [valid],
    Array.from({ length: 9 }, () => valid),
    [valid, { r: 1, g: 2 }],
    [valid, { r: 1, g: 2, b: 3, id: "c1" }],
    [valid, { r: "1", g: 2, b: 3 }],
    [valid, { r: -1, g: 2, b: 3 }],
  ]) {
    assert.throws(() => exportCss(invalid), RangeError);
  }

  const extraArrayProperty = [valid, { r: 4, g: 5, b: 6 }];
  extraArrayProperty.custom = "ignored data must still be rejected";
  assert.throws(() => exportCss(extraArrayProperty), RangeError);

  const sparse = [valid, { r: 4, g: 5, b: 6 }];
  delete sparse[0];
  assert.throws(() => exportCss(sparse), RangeError);

  const revoked = Proxy.revocable({ r: 4, g: 5, b: 6 }, {});
  revoked.revoke();
  assert.throws(() => exportCss([valid, revoked.proxy]), RangeError);
});

test("export reads frozen input without changing it", () => {
  const first = Object.freeze({ r: 1, g: 2, b: 3 });
  const second = Object.freeze({ r: 4, g: 5, b: 6 });
  const colors = Object.freeze([first, second]);
  const before = JSON.stringify(colors);
  exportCss(colors);
  assert.equal(JSON.stringify(colors), before);
});
