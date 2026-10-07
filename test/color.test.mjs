import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHex,
  formatHsl,
  formatRgb,
  hslToRgb,
  parseHex,
  parseHslFields,
  parseRgbFields,
  rgbToHsl,
} from "../public/js/core/color.mjs";

test("CP-01: trimmed short HEX expands to RGB and uppercase HEX", () => {
  const parsed = parseHex(" #a3f ");
  assert.deepStrictEqual(parsed, { ok: true, value: { r: 170, g: 51, b: 255 } });
  assert.equal(formatHex(parsed.value), "#AA33FF");
});

test("CP-02: HEX rejects alpha, names, malformed lengths, and overlong raw input", () => {
  for (const input of ["#1234", "red", "#12345678", "#12", "#ggg", `${"#"}${"a".repeat(32)}`]) {
    assert.deepStrictEqual(parseHex(input), { ok: false, code: "COLOR_INVALID" }, input);
  }
  assert.deepStrictEqual(parseHex(`${" ".repeat(14)}#abc${" ".repeat(14)}`), {
    ok: true,
    value: { r: 170, g: 187, b: 204 },
  });
  assert.deepStrictEqual(parseHex(`${" ".repeat(16)}#abc${" ".repeat(16)}`), {
    ok: false,
    code: "COLOR_INVALID",
  });
});

test("CP-03: RGB fields use complete unsigned ASCII integers and distinguish range errors", () => {
  assert.deepStrictEqual(parseRgbFields({ r: "255", g: "0", b: "0" }), {
    ok: true,
    value: { r: 255, g: 0, b: 0 },
  });
  assert.deepStrictEqual(parseRgbFields({ r: "256", g: "0", b: "0" }), {
    ok: false,
    code: "VALUE_OUT_OF_RANGE",
  });
  for (const fields of [
    { r: "1e2", g: "0", b: "0" },
    { r: "-1", g: "0", b: "0" },
    { r: "1.0", g: "0", b: "0" },
    { r: "", g: "0", b: "0" },
    { r: "000000000", g: "0", b: "0" },
  ]) {
    assert.deepStrictEqual(parseRgbFields(fields), { ok: false, code: "COLOR_INVALID" });
  }
});

test("RGB and HSL parsers reject wrong types, unknown or inherited keys, and accessors", () => {
  for (const fields of [
    null,
    3,
    ["1", "2", "3"],
    { r: "1", g: "2" },
    { r: "1", g: "2", b: "3", extra: "4" },
    Object.assign(Object.create({ r: "1" }), { g: "2", b: "3" }),
    Object.defineProperty({ g: "2", b: "3" }, "r", { get() { return "1"; } }),
    { r: 1, g: "2", b: "3" },
  ]) {
    assert.deepStrictEqual(parseRgbFields(fields), { ok: false, code: "COLOR_INVALID" });
  }
  assert.deepStrictEqual(parseRgbFields({ r: "1", g: "2", b: "3", [Symbol("extra")]: "4" }), {
    ok: false,
    code: "COLOR_INVALID",
  });
  assert.deepStrictEqual(parseHslFields({ h: "0", s: "100", l: "50", extra: "0" }), {
    ok: false,
    code: "COLOR_INVALID",
  });
});

test("CP-04 and CP-05: HSL accepts hue 360 as zero and converts primary hues", () => {
  for (const fields of [{ h: "0", s: "100", l: "50" }, { h: "360", s: "100", l: "50" }]) {
    const parsed = parseHslFields(fields);
    assert.equal(parsed.ok, true);
    assert.deepStrictEqual(hslToRgb(parsed.value), { r: 255, g: 0, b: 0 });
  }
  assert.deepStrictEqual(hslToRgb(parseHslFields({ h: "120", s: "100", l: "50" }).value), {
    r: 0,
    g: 255,
    b: 0,
  });
  assert.deepStrictEqual(hslToRgb(parseHslFields({ h: "240", s: "100", l: "50" }).value), {
    r: 0,
    g: 0,
    b: 255,
  });
});

test("HSL parser accepts one decimal and an eight-character field, rejecting malformed or out-of-range values", () => {
  assert.deepStrictEqual(parseHslFields({ h: "120.5", s: "50.0", l: "12.3" }), {
    ok: true,
    value: { h: 120.5, s: 50, l: 12.3 },
  });
  assert.deepStrictEqual(parseHslFields({ h: "00000120", s: "00000050", l: "00000050" }), {
    ok: true,
    value: { h: 120, s: 50, l: 50 },
  });
  for (const fields of [
    { h: "120.55", s: "50", l: "50" },
    { h: "", s: "50", l: "50" },
    { h: "1e2", s: "50", l: "50" },
    { h: "NaN", s: "50", l: "50" },
    { h: "Infinity", s: "50", l: "50" },
    { h: "000000120", s: "50", l: "50" },
    { h: 120, s: "50", l: "50" },
    { h: "120", s: Number.NaN, l: "50" },
  ]) {
    assert.deepStrictEqual(parseHslFields(fields), { ok: false, code: "COLOR_INVALID" });
  }
  for (const fields of [
    { h: "360.1", s: "50", l: "50" },
    { h: "120", s: "100.1", l: "50" },
    { h: "120", s: "50", l: "100.1" },
  ]) {
    assert.deepStrictEqual(parseHslFields(fields), { ok: false, code: "VALUE_OUT_OF_RANGE" });
  }
});

test("HSL conversion covers six hue sectors, endpoints, and achromatic colors", () => {
  const samples = [
    [{ h: 0, s: 100, l: 50 }, { r: 255, g: 0, b: 0 }],
    [{ h: 30, s: 100, l: 50 }, { r: 255, g: 128, b: 0 }],
    [{ h: 60, s: 100, l: 50 }, { r: 255, g: 255, b: 0 }],
    [{ h: 90, s: 100, l: 50 }, { r: 128, g: 255, b: 0 }],
    [{ h: 120, s: 100, l: 50 }, { r: 0, g: 255, b: 0 }],
    [{ h: 150, s: 100, l: 50 }, { r: 0, g: 255, b: 128 }],
    [{ h: 180, s: 100, l: 50 }, { r: 0, g: 255, b: 255 }],
    [{ h: 210, s: 100, l: 50 }, { r: 0, g: 128, b: 255 }],
    [{ h: 240, s: 100, l: 50 }, { r: 0, g: 0, b: 255 }],
    [{ h: 270, s: 100, l: 50 }, { r: 128, g: 0, b: 255 }],
    [{ h: 300, s: 100, l: 50 }, { r: 255, g: 0, b: 255 }],
    [{ h: 330, s: 100, l: 50 }, { r: 255, g: 0, b: 128 }],
    [{ h: 360, s: 100, l: 50 }, { r: 255, g: 0, b: 0 }],
    [{ h: 210, s: 80, l: 0 }, { r: 0, g: 0, b: 0 }],
    [{ h: 210, s: 80, l: 100 }, { r: 255, g: 255, b: 255 }],
    [{ h: 270, s: 0, l: 50 }, { r: 128, g: 128, b: 128 }],
  ];
  for (const [input, expected] of samples) assert.deepStrictEqual(hslToRgb(input), expected);
});

test("CP-06: RGB to HSL preserves precision while formatting rounds only for display", () => {
  const gray = Object.freeze({ r: 128, g: 128, b: 128 });
  const hsl = rgbToHsl(gray);
  assert.equal(hsl.h, 0);
  assert.equal(hsl.s, 0);
  assert.ok(Math.abs(hsl.l - 50.19607843137255) < 1e-12);
  assert.equal(formatHsl(gray), "hsl(0, 0%, 50.2%)");
  assert.deepStrictEqual(rgbToHsl({ r: 255, g: 0, b: 0 }), { h: 0, s: 100, l: 50 });
});

test("RGB to HSL handles very dark, near-white, maximum-green, maximum-blue, and negative hues", () => {
  const darkRed = rgbToHsl({ r: 1, g: 0, b: 0 });
  assert.deepStrictEqual(darkRed, { h: 0, s: 100, l: 0.19607843137254902 });
  assert.deepStrictEqual(hslToRgb(darkRed), { r: 1, g: 0, b: 0 });

  const nearWhiteRed = rgbToHsl({ r: 255, g: 254, b: 254 });
  assert.equal(nearWhiteRed.h, 0);
  assert.equal(nearWhiteRed.s, 100);
  assert.ok(Math.abs(nearWhiteRed.l - 99.80392156862744) < 1e-12);
  assert.deepStrictEqual(hslToRgb(nearWhiteRed), { r: 255, g: 254, b: 254 });

  assert.deepStrictEqual(rgbToHsl({ r: 0, g: 1, b: 0 }), {
    h: 120,
    s: 100,
    l: 0.19607843137254902,
  });
  assert.deepStrictEqual(rgbToHsl({ r: 0, g: 0, b: 1 }), {
    h: 240,
    s: 100,
    l: 0.19607843137254902,
  });
  assert.deepStrictEqual(rgbToHsl({ r: 2, g: 0, b: 1 }), {
    h: 330,
    s: 100,
    l: 0.39215686274509803,
  });
});

test("bounded RGB grid stays in HSL range and round-trips all 8-bit samples", () => {
  const channels = [0, 1, 127, 254, 255];
  for (const r of channels) {
    for (const g of channels) {
      for (const b of channels) {
        const rgb = { r, g, b };
        const hsl = rgbToHsl(rgb);
        assert.ok(Number.isFinite(hsl.h) && hsl.h >= 0 && hsl.h < 360, JSON.stringify({ rgb, hsl }));
        assert.ok(Number.isFinite(hsl.s) && hsl.s >= 0 && hsl.s <= 100, JSON.stringify({ rgb, hsl }));
        assert.ok(Number.isFinite(hsl.l) && hsl.l >= 0 && hsl.l <= 100, JSON.stringify({ rgb, hsl }));
        assert.deepStrictEqual(hslToRgb(hsl), rgb, JSON.stringify({ rgb, hsl }));
      }
    }
  }
});

test("formatters return stable HEX, RGB, and HSL text without changing inputs", () => {
  const rgb = Object.freeze({ r: 170, g: 51, b: 255 });
  assert.equal(formatHex(rgb), "#AA33FF");
  assert.equal(formatRgb(rgb), "rgb(170, 51, 255)");
  assert.equal(formatHsl({ r: 255, g: 0, b: 0 }), "hsl(0, 100%, 50%)");
  assert.deepStrictEqual(rgb, { r: 170, g: 51, b: 255 });
});

test("all 8-bit saturated channel boundaries remain valid without relaxing input ranges", () => {
  assert.equal(rgbToHsl({ r: 255, g: 9, b: 9 }).s, 100);
  for (let channel = 0; channel <= 255; channel += 1) {
    const samples = [
      { r: channel, g: 0, b: 0 }, { r: 0, g: channel, b: 0 }, { r: 0, g: 0, b: channel },
      { r: 255, g: channel, b: channel }, { r: channel, g: 255, b: channel }, { r: channel, g: channel, b: 255 },
    ];
    for (const rgb of samples) {
      const hsl = rgbToHsl(rgb);
      const expectedSaturation = rgb.r === rgb.g && rgb.g === rgb.b ? 0 : 100;
      assert.equal(hsl.s, expectedSaturation, JSON.stringify({rgb, hsl}));
      assert.deepStrictEqual(hslToRgb(hsl), rgb);
    }
  }
  assert.throws(() => hslToRgb({h:0,s:100.00000000000003,l:50}), RangeError);
});

test("numeric conversion and formatting reject malformed records with RangeError", () => {
  for (const invalidRgb of [
    null,
    { r: 255, g: 0 },
    { r: 255, g: 0, b: 0, alpha: 1 },
    { r: "255", g: 0, b: 0 },
    { r: 256, g: 0, b: 0 },
    { r: 1.5, g: 0, b: 0 },
    { r: NaN, g: 0, b: 0 },
  ]) {
    assert.throws(() => rgbToHsl(invalidRgb), RangeError);
    assert.throws(() => formatHex(invalidRgb), RangeError);
    assert.throws(() => formatRgb(invalidRgb), RangeError);
    assert.throws(() => formatHsl(invalidRgb), RangeError);
  }
  for (const invalidHsl of [
    null,
    { h: 0, s: 0 },
    { h: 0, s: 0, l: 50, id: "c1" },
    { h: "0", s: 100, l: 50 },
    { h: 361, s: 100, l: 50 },
    { h: 0, s: Infinity, l: 50 },
    { h: 0, s: 100.00000000000036, l: 50 },
  ]) {
    assert.throws(() => hslToRgb(invalidHsl), RangeError);
  }
});
