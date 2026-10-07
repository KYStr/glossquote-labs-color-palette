import assert from "node:assert/strict";
import test from "node:test";
import {
  contrastRatio,
  evaluateContrast,
  relativeLuminance,
} from "../public/js/core/contrast.mjs";

test("CP-07 and CP-08: black/white and identical colors have exact endpoint ratios", () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.equal(contrastRatio({ r: 18, g: 52, b: 86 }, { r: 18, g: 52, b: 86 }), 1);
  assert.equal(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 21);
});

test("CP-09 and CP-10: known sRGB contrast values retain unrounded precision", () => {
  const white = { r: 255, g: 255, b: 255 };
  const gray777 = { r: 119, g: 119, b: 119 };
  const gray767676 = { r: 118, g: 118, b: 118 };
  assert.ok(Math.abs(contrastRatio(gray777, white) - 4.478089453577214) < 1e-12);
  assert.ok(Math.abs(contrastRatio(gray767676, white) - 4.542224959605253) < 1e-12);
});

test("contrast thresholds use the raw ratio rather than a rounded display value", () => {
  assert.deepStrictEqual(evaluateContrast(4.499999), {
    normalAA: false,
    normalAAA: false,
    largeAA: true,
    largeAAA: false,
  });
  assert.deepStrictEqual(evaluateContrast(4.5), {
    normalAA: true,
    normalAAA: false,
    largeAA: true,
    largeAAA: true,
  });
  assert.deepStrictEqual(evaluateContrast(7), {
    normalAA: true,
    normalAAA: true,
    largeAA: true,
    largeAAA: true,
  });
  assert.deepStrictEqual(evaluateContrast(1), {
    normalAA: false,
    normalAAA: false,
    largeAA: false,
    largeAAA: false,
  });
  assert.deepStrictEqual(evaluateContrast(21), {
    normalAA: true,
    normalAAA: true,
    largeAA: true,
    largeAAA: true,
  });
});

test("contrast functions reject invalid RGB records and non-finite or out-of-range ratios", () => {
  for (const rgb of [
    null,
    { r: 0, g: 0 },
    { r: 0, g: 0, b: 0, a: 1 },
    { r: "0", g: 0, b: 0 },
    { r: 0, g: -1, b: 0 },
    { r: 0.5, g: 0, b: 0 },
    Object.assign(Object.create({ r: 0 }), { g: 0, b: 0 }),
  ]) {
    assert.throws(() => relativeLuminance(rgb), RangeError);
    assert.throws(() => contrastRatio(rgb, { r: 255, g: 255, b: 255 }), RangeError);
  }
  for (const ratio of [0.99, 21.000001, Infinity, NaN, "4.5", null, new Number(4.5)]) {
    assert.throws(() => evaluateContrast(ratio), RangeError);
  }
});

test("contrast inputs are read-only", () => {
  const foreground = Object.freeze({ r: 119, g: 119, b: 119 });
  const background = Object.freeze({ r: 255, g: 255, b: 255 });
  const before = [foreground.r, foreground.g, foreground.b, background.r, background.g, background.b];
  contrastRatio(foreground, background);
  assert.deepStrictEqual(
    [foreground.r, foreground.g, foreground.b, background.r, background.g, background.b],
    before,
  );
});
