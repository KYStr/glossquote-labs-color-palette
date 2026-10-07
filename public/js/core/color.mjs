const RGB_KEYS = ["r", "g", "b"];
const HSL_KEYS = ["h", "s", "l"];

function exactDataRecord(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;

    const record = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function invalidParse() {
  return { ok: false, code: "COLOR_INVALID" };
}

function outOfRangeParse() {
  return { ok: false, code: "VALUE_OUT_OF_RANGE" };
}

function parseNumericFields(fields, keys, pattern, ranges, normalizeHue = false) {
  const record = exactDataRecord(fields, keys);
  if (!record) return invalidParse();

  const values = Object.create(null);
  for (const key of keys) {
    const text = record[key];
    if (typeof text !== "string" || text.length > 8 || !pattern.test(text)) return invalidParse();
    values[key] = Number(text);
  }

  for (const key of keys) {
    const [minimum, maximum] = ranges[key];
    if (values[key] < minimum || values[key] > maximum) return outOfRangeParse();
  }

  if (normalizeHue && values.h === 360) values.h = 0;
  return { ok: true, value: { ...values } };
}

function requireRgb(rgb) {
  const record = exactDataRecord(rgb, RGB_KEYS);
  if (!record || RGB_KEYS.some((key) => (
    typeof record[key] !== "number" ||
    !Number.isFinite(record[key]) ||
    !Number.isInteger(record[key]) ||
    record[key] < 0 ||
    record[key] > 255
  ))) {
    throw new RangeError("Expected an RGB record with integer channels from 0 to 255.");
  }
  return record;
}

function requireHsl(hsl) {
  const record = exactDataRecord(hsl, HSL_KEYS);
  if (!record || HSL_KEYS.some((key) => typeof record[key] !== "number" || !Number.isFinite(record[key]))) {
    throw new RangeError("Expected a finite HSL record.");
  }
  if (record.h < 0 || record.h > 360 || record.s < 0 || record.s > 100 || record.l < 0 || record.l > 100) {
    throw new RangeError("HSL values are outside their supported ranges.");
  }
  return record;
}

function formatOneDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function parseHex(text) {
  if (typeof text !== "string" || text.length > 32) return invalidParse();
  const trimmed = text.trim();
  if (!/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(trimmed)) return invalidParse();

  const digits = trimmed.slice(1);
  const expanded = digits.length === 3
    ? [...digits].map((digit) => `${digit}${digit}`).join("")
    : digits;
  return {
    ok: true,
    value: {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
    },
  };
}

export function parseRgbFields(fields) {
  return parseNumericFields(
    fields,
    RGB_KEYS,
    /^[0-9]+$/,
    { r: [0, 255], g: [0, 255], b: [0, 255] },
  );
}

export function parseHslFields(fields) {
  return parseNumericFields(
    fields,
    HSL_KEYS,
    /^[0-9]+(?:\.[0-9])?$/,
    { h: [0, 360], s: [0, 100], l: [0, 100] },
    true,
  );
}

export function hslToRgb(hsl) {
  const { h: rawHue, s: saturation, l: lightness } = requireHsl(hsl);
  const hue = rawHue === 360 ? 0 : rawHue;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;

  let channels;
  if (hue < 60) channels = [chroma, x, 0];
  else if (hue < 120) channels = [x, chroma, 0];
  else if (hue < 180) channels = [0, chroma, x];
  else if (hue < 240) channels = [0, x, chroma];
  else if (hue < 300) channels = [x, 0, chroma];
  else channels = [chroma, 0, x];

  const [r, g, b] = channels.map((channel) => {
    const byte = Math.round((channel + m) * 255);
    // Floating-point cancellation may produce -0; RGB has a single zero value.
    return byte === 0 ? 0 : byte;
  });
  return { r, g, b };
}

export function rgbToHsl(rgb) {
  const { r: redByte, g: greenByte, b: blueByte } = requireRgb(rgb);
  const r = redByte / 255;
  const g = greenByte / 255;
  const b = blueByte / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const l = (maximum + minimum) / 2;

  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  let h;
  if (maximum === r) h = 60 * (((g - b) / delta) % 6);
  else if (maximum === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;

  const sum = maximum + minimum;
  // Subtract each channel before adding to retain precision near gamut edges.
  const saturationDenominator = sum <= 1 ? sum : (1 - maximum) + (1 - minimum);
  const s = delta / saturationDenominator;
  return { h, s: s * 100, l: l * 100 };
}

export function formatHex(rgb) {
  const record = requireRgb(rgb);
  const hex = RGB_KEYS.map((key) => record[key].toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}`;
}

export function formatRgb(rgb) {
  const { r, g, b } = requireRgb(rgb);
  return `rgb(${r}, ${g}, ${b})`;
}

export function formatHsl(rgb) {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${formatOneDecimal(h)}, ${formatOneDecimal(s)}%, ${formatOneDecimal(l)}%)`;
}
