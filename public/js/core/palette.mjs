import {
  formatHex,
  formatHsl,
  hslToRgb,
  parseHex,
  parseHslFields,
  parseRgbFields,
} from "./color.mjs";

const STATE_KEYS = ["colors", "nextId", "selectedId", "foregroundId", "backgroundId", "drafts"];
const MODE_FIELDS = {
  hex: ["hex"],
  rgb: ["r", "g", "b"],
  hsl: ["h", "s", "l"],
};
const PARSE_ERROR_CODES = new Set(["COLOR_INVALID", "VALUE_OUT_OF_RANGE"]);

function exactRecord(value, keys) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
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

function exactArray(value, minimum, maximum) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = value.length;
    if (!Number.isInteger(length) || length < minimum || length > maximum) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) return null;

    const items = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!ownKeys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function readOwnDataProperty(value, key) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function sequenceFromId(id) {
  if (typeof id !== "string") return null;
  const match = /^c([1-9][0-9]*)$/.exec(id);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function rgbOf(color) {
  return { r: color.r, g: color.g, b: color.b };
}

function formatFields(mode, rgb) {
  if (mode === "hex") return { hex: formatHex(rgb) };
  if (mode === "rgb") return { r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) };

  const formatted = formatHsl(rgb);
  const match = /^hsl\(([^,]+), ([^,]+)%, ([^)]+)%\)$/.exec(formatted);
  if (!match) throw new RangeError("The formatted HSL value did not match its fixed format.");
  return { h: match[1], s: match[2], l: match[3] };
}

function parseFields(mode, fields) {
  if (mode === "hex") return parseHex(fields.hex);
  if (mode === "rgb") return parseRgbFields(fields);
  if (mode === "hsl") return parseHslFields(fields);
  return { ok: false, code: "COLOR_INVALID" };
}

function makeDraft(mode, rgb) {
  return { mode, fields: formatFields(mode, rgb), dirty: false, error: null };
}

function fieldsMatch(actual, expected, keys) {
  return keys.every((key) => actual[key] === expected[key]);
}

function validState(state) {
  const value = exactRecord(state, STATE_KEYS);
  if (!value || !Number.isSafeInteger(value.nextId) || value.nextId < 3) return false;

  const colors = exactArray(value.colors, 2, 8);
  if (!colors) return false;

  const ids = [];
  const idSequences = [];
  const seen = new Set();
  for (const item of colors) {
    const color = exactRecord(item, ["id", "r", "g", "b"]);
    if (!color || [color.r, color.g, color.b].some((channel) => (
      typeof channel !== "number" ||
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel > 255
    ))) return false;
    const sequence = sequenceFromId(color.id);
    if (sequence === null || sequence >= value.nextId || seen.has(color.id)) return false;
    ids.push(color.id);
    idSequences.push(sequence);
    seen.add(color.id);
  }

  if (value.nextId <= Math.max(...idSequences)) return false;
  if (![value.selectedId, value.foregroundId, value.backgroundId].every((id) => seen.has(id))) return false;

  const drafts = exactRecord(value.drafts, ids);
  if (!drafts) return false;
  for (const color of colors) {
    const draft = exactRecord(drafts[color.id], ["mode", "fields", "dirty", "error"]);
    if (!draft || typeof draft.mode !== "string" || !Object.hasOwn(MODE_FIELDS, draft.mode) || typeof draft.dirty !== "boolean") return false;
    if (draft.error !== null && !PARSE_ERROR_CODES.has(draft.error)) return false;

    const fieldNames = MODE_FIELDS[draft.mode];
    const fields = exactRecord(draft.fields, fieldNames);
    if (!fields || fieldNames.some((key) => typeof fields[key] !== "string")) return false;
    const parsed = parseFields(draft.mode, fields);
    const expectedError = parsed.ok ? null : parsed.code;
    if (draft.error !== expectedError || (!draft.dirty && expectedError !== null)) return false;
    if (!draft.dirty && !fieldsMatch(fields, formatFields(draft.mode, rgbOf(color)), fieldNames)) return false;
  }
  return true;
}

function copyState(state) {
  const colors = state.colors.map((color) => ({ id: color.id, r: color.r, g: color.g, b: color.b }));
  const drafts = {};
  for (const color of state.colors) {
    const draft = state.drafts[color.id];
    const fields = {};
    for (const key of MODE_FIELDS[draft.mode]) fields[key] = draft.fields[key];
    drafts[color.id] = { mode: draft.mode, fields, dirty: draft.dirty, error: draft.error };
  }
  return {
    colors,
    nextId: state.nextId,
    selectedId: state.selectedId,
    foregroundId: state.foregroundId,
    backgroundId: state.backgroundId,
    drafts,
  };
}

function success(value) {
  return { ok: true, value };
}

function failure(code = "COLOR_INVALID") {
  return { ok: false, code };
}

function failureForParse(parsed) {
  return failure(PARSE_ERROR_CODES.has(parsed.code) ? parsed.code : "COLOR_INVALID");
}

function findColor(state, id) {
  return state.colors.find((color) => color.id === id);
}

function updateDraftMode(state, id, mode) {
  if (typeof mode !== "string" || !Object.hasOwn(MODE_FIELDS, mode)) return failure();
  const color = findColor(state, id);
  if (!color) return failure();
  const next = copyState(state);
  next.drafts[id] = makeDraft(mode, rgbOf(color));
  return success(next);
}

function updateDraftFields(state, id, fieldsInput) {
  const current = state.drafts[id];
  const fieldNames = MODE_FIELDS[current.mode];
  const fields = exactRecord(fieldsInput, fieldNames);
  if (!fields || fieldNames.some((key) => typeof fields[key] !== "string")) return failure();

  const parsed = parseFields(current.mode, fields);
  const next = copyState(state);
  const copiedFields = {};
  for (const key of fieldNames) copiedFields[key] = fields[key];
  next.drafts[id] = {
    mode: current.mode,
    fields: copiedFields,
    dirty: true,
    error: parsed.ok ? null : parsed.code,
  };
  return success(next);
}

function commitDraft(state, id) {
  const draft = state.drafts[id];
  if (!draft.dirty || draft.error !== null) return success(state);

  const parsed = parseFields(draft.mode, draft.fields);
  if (!parsed.ok) return success(state);
  const rgb = draft.mode === "hsl" ? hslToRgb(parsed.value) : parsed.value;
  const next = copyState(state);
  next.colors = next.colors.map((color) => (
    color.id === id ? { id, r: rgb.r, g: rgb.g, b: rgb.b } : color
  ));
  next.drafts[id] = makeDraft(draft.mode, rgb);
  return success(next);
}

export function createPalette() {
  const colors = [
    { id: "c1", r: 17, g: 20, b: 16 },
    { id: "c2", r: 243, g: 240, b: 232 },
  ];
  return {
    colors,
    nextId: 3,
    selectedId: "c1",
    foregroundId: "c1",
    backgroundId: "c2",
    drafts: {
      c1: makeDraft("hex", rgbOf(colors[0])),
      c2: makeDraft("hex", rgbOf(colors[1])),
    },
  };
}

export function reducePalette(state, action) {
  if (!validState(state)) return failure();
  const type = readOwnDataProperty(action, "type");

  if (type === "add") {
    if (!exactRecord(action, ["type"])) return failure();
    if (state.colors.length >= 8) return failure("PALETTE_LIMIT");
    if (state.nextId >= Number.MAX_SAFE_INTEGER) return failure("VALUE_OUT_OF_RANGE");
    const id = `c${state.nextId}`;
    const next = copyState(state);
    const color = { id, r: 255, g: 255, b: 255 };
    next.colors.push(color);
    next.nextId += 1;
    next.selectedId = id;
    next.drafts[id] = makeDraft("hex", rgbOf(color));
    return success(next);
  }

  if (type === "remove") {
    const actionValue = exactRecord(action, ["type", "id"]);
    if (!actionValue || typeof actionValue.id !== "string" || !findColor(state, actionValue.id)) return failure();
    if (state.colors.length <= 2) return failure("PALETTE_LIMIT");
    const removedId = actionValue.id;
    const next = copyState(state);
    next.colors = next.colors.filter((color) => color.id !== removedId);
    delete next.drafts[removedId];
    if (next.selectedId === removedId) next.selectedId = next.colors[0].id;
    if (state.foregroundId === removedId || state.backgroundId === removedId) {
      next.foregroundId = next.colors[0].id;
      next.backgroundId = next.colors[1].id;
    }
    return success(next);
  }

  if (type === "move") {
    const actionValue = exactRecord(action, ["type", "id", "direction"]);
    if (!actionValue || typeof actionValue.id !== "string" || !findColor(state, actionValue.id)) return failure();
    if (actionValue.direction !== "previous" && actionValue.direction !== "next") return failure();
    const index = state.colors.findIndex((color) => color.id === actionValue.id);
    const destination = index + (actionValue.direction === "previous" ? -1 : 1);
    if (destination < 0 || destination >= state.colors.length) return failure("VALUE_OUT_OF_RANGE");
    const next = copyState(state);
    [next.colors[index], next.colors[destination]] = [next.colors[destination], next.colors[index]];
    return success(next);
  }

  if (type === "select-pair") {
    const actionValue = exactRecord(action, ["type", "selectedId", "foregroundId", "backgroundId"]);
    if (!actionValue || ![actionValue.selectedId, actionValue.foregroundId, actionValue.backgroundId]
      .every((id) => typeof id === "string" && findColor(state, id))) return failure();
    const next = copyState(state);
    next.selectedId = actionValue.selectedId;
    next.foregroundId = actionValue.foregroundId;
    next.backgroundId = actionValue.backgroundId;
    return success(next);
  }

  if (type === "swap") {
    if (!exactRecord(action, ["type"])) return failure();
    const next = copyState(state);
    [next.foregroundId, next.backgroundId] = [next.backgroundId, next.foregroundId];
    return success(next);
  }

  if (type === "reset") {
    if (!exactRecord(action, ["type"])) return failure();
    if (state.nextId > Number.MAX_SAFE_INTEGER - 2) return failure("VALUE_OUT_OF_RANGE");
    const firstId = `c${state.nextId}`;
    const secondId = `c${state.nextId + 1}`;
    const colors = [
      { id: firstId, r: 17, g: 20, b: 16 },
      { id: secondId, r: 243, g: 240, b: 232 },
    ];
    return success({
      colors,
      nextId: state.nextId + 2,
      selectedId: firstId,
      foregroundId: firstId,
      backgroundId: secondId,
      drafts: {
        [firstId]: makeDraft("hex", rgbOf(colors[0])),
        [secondId]: makeDraft("hex", rgbOf(colors[1])),
      },
    });
  }

  if (type === "update") {
    const operation = readOwnDataProperty(action, "operation");
    if (operation === "mode") {
      const actionValue = exactRecord(action, ["type", "id", "operation", "mode"]);
      if (!actionValue || typeof actionValue.id !== "string" || !findColor(state, actionValue.id)) return failure();
      return updateDraftMode(state, actionValue.id, actionValue.mode);
    }
    if (operation === "draft") {
      const actionValue = exactRecord(action, ["type", "id", "operation", "fields"]);
      if (!actionValue || typeof actionValue.id !== "string" || !findColor(state, actionValue.id)) return failure();
      return updateDraftFields(state, actionValue.id, actionValue.fields);
    }
    if (operation === "commit") {
      const actionValue = exactRecord(action, ["type", "id", "operation"]);
      if (!actionValue || typeof actionValue.id !== "string" || !findColor(state, actionValue.id)) return failure();
      return commitDraft(state, actionValue.id);
    }
    return failure();
  }

  return failure();
}
