import assert from "node:assert/strict";
import test from "node:test";
import { createPalette, reducePalette } from "../public/js/core/palette.mjs";

function apply(state, action) {
  const result = reducePalette(state, action);
  assert.equal(result.ok, true, JSON.stringify({ action, result }));
  return result.value;
}

function rejected(state, action, code = "COLOR_INVALID") {
  assert.deepStrictEqual(reducePalette(state, action), { ok: false, code });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("createPalette starts with the exact committed RGB values and clean HEX drafts", () => {
  const first = createPalette();
  const second = createPalette();
  assert.deepStrictEqual(first, {
    colors: [
      { id: "c1", r: 17, g: 20, b: 16 },
      { id: "c2", r: 243, g: 240, b: 232 },
    ],
    nextId: 3,
    selectedId: "c1",
    foregroundId: "c1",
    backgroundId: "c2",
    drafts: {
      c1: { mode: "hex", fields: { hex: "#111410" }, dirty: false, error: null },
      c2: { mode: "hex", fields: { hex: "#F3F0E8" }, dirty: false, error: null },
    },
  });
  assert.notEqual(first, second);
  assert.notEqual(first.colors, second.colors);
});

test("CP-12: add white through eight colors, enforce both palette limits, and select the new color", () => {
  let state = createPalette();
  for (let count = 3; count <= 8; count += 1) {
    state = apply(state, { type: "add" });
    const added = state.colors.at(-1);
    assert.equal(added.id, `c${count}`);
    assert.deepStrictEqual({ r: added.r, g: added.g, b: added.b }, { r: 255, g: 255, b: 255 });
    assert.equal(state.selectedId, added.id);
  }
  assert.equal(state.colors.length, 8);
  rejected(state, { type: "add" }, "PALETTE_LIMIT");
  rejected(createPalette(), { type: "remove", id: "c1" }, "PALETTE_LIMIT");
  rejected(createPalette(), { type: "remove", id: "missing" });
});

test("move preserves selection and comparison ids; endpoint moves return VALUE_OUT_OF_RANGE", () => {
  let state = apply(createPalette(), { type: "add" });
  state = apply(state, {
    type: "select-pair",
    selectedId: "c2",
    foregroundId: "c3",
    backgroundId: "c1",
  });
  state = apply(state, { type: "move", id: "c3", direction: "previous" });
  assert.deepStrictEqual(state.colors.map(({ id }) => id), ["c1", "c3", "c2"]);
  assert.equal(state.selectedId, "c2");
  assert.equal(state.foregroundId, "c3");
  assert.equal(state.backgroundId, "c1");
  rejected(state, { type: "move", id: "c1", direction: "previous" }, "VALUE_OUT_OF_RANGE");
  rejected(state, { type: "move", id: "c2", direction: "next" }, "VALUE_OUT_OF_RANGE");
  rejected(state, { type: "move", id: "c2", direction: "first" });
});

test("swap changes only foreground and background selection", () => {
  const initial = createPalette();
  const swapped = apply(initial, { type: "swap" });
  assert.deepStrictEqual(swapped.colors, initial.colors);
  assert.equal(swapped.selectedId, initial.selectedId);
  assert.equal(swapped.foregroundId, "c2");
  assert.equal(swapped.backgroundId, "c1");
});

test("CP-13: removing a comparison color resets both comparison ids to the first two remaining", () => {
  let state = apply(createPalette(), { type: "add" });
  state = apply(state, {
    type: "select-pair",
    selectedId: "c2",
    foregroundId: "c1",
    backgroundId: "c2",
  });
  state = apply(state, { type: "remove", id: "c2" });
  assert.deepStrictEqual(state.colors.map(({ id }) => id), ["c1", "c3"]);
  assert.equal(state.selectedId, "c1");
  assert.equal(state.foregroundId, "c1");
  assert.equal(state.backgroundId, "c3");
  assert.deepStrictEqual(Object.keys(state.drafts).sort(), ["c1", "c3"]);
});

test("removing the selected non-comparison color selects the first remaining and preserves the pair", () => {
  let state = apply(createPalette(), { type: "add" });
  state = apply(state, {
    type: "select-pair",
    selectedId: "c3",
    foregroundId: "c1",
    backgroundId: "c2",
  });
  state = apply(state, { type: "remove", id: "c3" });
  assert.equal(state.selectedId, "c1");
  assert.equal(state.foregroundId, "c1");
  assert.equal(state.backgroundId, "c2");
});

test("reset returns base RGB values with fresh monotonic ids and fresh drafts", () => {
  let state = apply(createPalette(), { type: "add" });
  state = apply(state, { type: "remove", id: "c3" });
  state = apply(state, { type: "reset" });
  assert.deepStrictEqual(state.colors, [
    { id: "c4", r: 17, g: 20, b: 16 },
    { id: "c5", r: 243, g: 240, b: 232 },
  ]);
  assert.equal(state.nextId, 6);
  assert.equal(state.selectedId, "c4");
  assert.equal(state.foregroundId, "c4");
  assert.equal(state.backgroundId, "c5");
  assert.deepStrictEqual(Object.keys(state.drafts).sort(), ["c4", "c5"]);
  state = apply(state, { type: "reset" });
  assert.deepStrictEqual(state.colors.map(({ id }) => id), ["c6", "c7"]);
});

test("ID exhaustion returns VALUE_OUT_OF_RANGE without producing an unsafe nextId", () => {
  const state = { ...createPalette(), nextId: Number.MAX_SAFE_INTEGER };
  rejected(state, { type: "add" }, "VALUE_OUT_OF_RANGE");
  rejected(state, { type: "reset" }, "VALUE_OUT_OF_RANGE");
});

test("mode changes format only the committed RGB and clear the previous draft", () => {
  const initial = createPalette();
  const next = apply(initial, { type: "update", id: "c1", operation: "mode", mode: "rgb" });
  assert.deepStrictEqual(next.colors, initial.colors);
  assert.deepStrictEqual(next.drafts.c1, {
    mode: "rgb",
    fields: { r: "17", g: "20", b: "16" },
    dirty: false,
    error: null,
  });
  const hex = apply(next, { type: "update", id: "c1", operation: "mode", mode: "hex" });
  assert.deepStrictEqual(hex.drafts.c1, {
    mode: "hex",
    fields: { hex: "#111410" },
    dirty: false,
    error: null,
  });
});

test("valid RGB and HSL drafts commit to RGB and then become canonical clean fields", () => {
  let state = apply(createPalette(), { type: "update", id: "c1", operation: "mode", mode: "rgb" });
  state = apply(state, {
    type: "update",
    id: "c1",
    operation: "draft",
    fields: { r: "255", g: "0", b: "0" },
  });
  assert.deepStrictEqual(state.colors[0], { id: "c1", r: 17, g: 20, b: 16 });
  assert.equal(state.drafts.c1.dirty, true);
  assert.equal(state.drafts.c1.error, null);
  state = apply(state, { type: "update", id: "c1", operation: "commit" });
  assert.deepStrictEqual(state.colors[0], { id: "c1", r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(state.drafts.c1, {
    mode: "rgb",
    fields: { r: "255", g: "0", b: "0" },
    dirty: false,
    error: null,
  });

  state = apply(state, { type: "update", id: "c1", operation: "mode", mode: "hsl" });
  state = apply(state, {
    type: "update",
    id: "c1",
    operation: "draft",
    fields: { h: "120", s: "100", l: "50" },
  });
  state = apply(state, { type: "update", id: "c1", operation: "commit" });
  assert.deepStrictEqual(state.colors[0], { id: "c1", r: 0, g: 255, b: 0 });
  assert.deepStrictEqual(state.drafts.c1, {
    mode: "hsl",
    fields: { h: "120", s: "100", l: "50" },
    dirty: false,
    error: null,
  });
});

test("invalid drafts remain editable, keep their error, and never replace committed RGB", () => {
  let state = apply(createPalette(), { type: "update", id: "c1", operation: "mode", mode: "hex" });
  state = apply(state, {
    type: "update",
    id: "c1",
    operation: "draft",
    fields: { hex: "#zz" },
  });
  const before = state.colors[0];
  assert.deepStrictEqual(state.drafts.c1, {
    mode: "hex",
    fields: { hex: "#zz" },
    dirty: true,
    error: "COLOR_INVALID",
  });
  const committed = apply(state, { type: "update", id: "c1", operation: "commit" });
  assert.deepStrictEqual(committed.colors[0], before);
  assert.deepStrictEqual(committed.drafts.c1, state.drafts.c1);

  state = apply(committed, { type: "update", id: "c1", operation: "mode", mode: "rgb" });
  state = apply(state, {
    type: "update",
    id: "c1",
    operation: "draft",
    fields: { r: "256", g: "0", b: "0" },
  });
  assert.equal(state.drafts.c1.error, "VALUE_OUT_OF_RANGE");
  assert.deepStrictEqual(state.colors[0], before);
});

test("clean HSL commit is a true no-op and cannot requantize committed RGB", () => {
  const state = apply(createPalette(), { type: "update", id: "c1", operation: "mode", mode: "hsl" });
  const result = reducePalette(state, { type: "update", id: "c1", operation: "commit" });
  assert.equal(result.ok, true);
  assert.equal(result.value, state);
  assert.deepStrictEqual(result.value.colors[0], { id: "c1", r: 17, g: 20, b: 16 });
});

test("reducer rejects unknown schemas and invalid states and leaves frozen inputs unchanged", () => {
  const initial = createPalette();
  rejected(initial, { type: "delete", id: "c1" });
  rejected(initial, { type: "add", extra: true });
  rejected(initial, { type: "swap", extra: true });
  rejected(initial, { type: "update", id: "c1", operation: "mode", mode: "rgb", extra: true });
  rejected(initial, { type: "update", id: "c1", operation: "mode", mode: "lab" });
  rejected(initial, { type: "update", id: "c1", operation: "draft", fields: { hex: "#fff", extra: "x" } });
  rejected(initial, { type: "update", id: "missing", operation: "commit" });
  rejected(initial, { type: "select-pair", selectedId: "c1", foregroundId: "c1", backgroundId: "missing" });
  rejected({ ...initial, unknown: true }, { type: "add" });
  rejected({ ...initial, colors: [{ ...initial.colors[0], extra: 1 }, initial.colors[1]] }, { type: "add" });
  rejected({ ...initial, nextId: 2 }, { type: "add" });
  rejected({
    ...initial,
    drafts: { ...initial.drafts, c1: { ...initial.drafts.c1, error: "VALUE_OUT_OF_RANGE" } },
  }, { type: "add" });

  const frozen = deepFreeze(createPalette());
  const before = JSON.stringify(frozen);
  const result = reducePalette(frozen, { type: "update", id: "c1", operation: "mode", mode: "rgb" });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(frozen), before);
});
