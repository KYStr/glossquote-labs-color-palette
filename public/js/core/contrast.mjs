const RGB_KEYS = ["r", "g", "b"];

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

function linearize(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb) {
  const { r, g, b } = requireRgb(rgb);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function evaluateContrast(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1 || ratio > 21) {
    throw new RangeError("Expected a finite contrast ratio from 1 to 21.");
  }
  return {
    normalAA: ratio >= 4.5,
    normalAAA: ratio >= 7,
    largeAA: ratio >= 3,
    largeAAA: ratio >= 4.5,
  };
}
