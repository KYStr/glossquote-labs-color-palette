import { formatHex } from "./color.mjs";

function readColorArray(colors) {
  try {
    if (!Array.isArray(colors) || Object.getPrototypeOf(colors) !== Array.prototype) return null;
    const length = colors.length;
    if (!Number.isInteger(length) || length < 2 || length > 8) return null;

    const ownKeys = Reflect.ownKeys(colors);
    if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) return null;

    const items = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!ownKeys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(colors, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

export function exportCss(colors) {
  const items = readColorArray(colors);
  if (!items) throw new RangeError("Expected an array of 2 to 8 exact RGB records.");

  const declarations = items.map((rgb, index) => {
    let hex;
    try {
      hex = formatHex(rgb);
    } catch {
      throw new RangeError("Expected exact RGB records with integer channels from 0 to 255.");
    }
    return `  --color-${index + 1}: ${hex};`;
  });
  return `:root {\n${declarations.join("\n")}\n}\n`;
}
