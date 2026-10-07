import {
  formatHex,
  formatHsl,
  formatRgb,
} from "./core/color.mjs";
import { contrastRatio, evaluateContrast } from "./core/contrast.mjs";
import { createPalette, reducePalette } from "./core/palette.mjs";
import { exportCss } from "./core/export.mjs";
import { createClipboardController, createDownloadController } from "./clipboard.mjs";
import { getMessages } from "./i18n.mjs";

function makeElement(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function makeButton(label, action, focusKey, options = {}) {
  const button = makeElement("button", options.className ?? "", label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.focusKey = focusKey;
  if (options.id) button.dataset.id = options.id;
  if (options.mode) button.dataset.mode = options.mode;
  if (options.direction) button.dataset.direction = options.direction;
  if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel);
  if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
  if (options.disabled) button.disabled = true;
  if (options.title) button.title = options.title;
  return button;
}

function committedHex(color) {
  return formatHex({ r: color.r, g: color.g, b: color.b });
}

function colorOrdinal(state, id) {
  return state.colors.findIndex((color) => color.id === id) + 1;
}

function isPaletteDirty(state) {
  return state.colors.some((color) => state.drafts[color.id].dirty);
}

function createBrowserDownloadController() {
  return createDownloadController({
    createBlob: (text) => new Blob([text], { type: "text/css;charset=utf-8" }),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    triggerDownload: (url, filename) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },
  });
}

function bootPalette(root) {
  const locale = root.dataset.locale === "en" ? "en" : "zh-Hant";
  const t = getMessages(locale);
  let state = createPalette();
  let startingColorIds = new Set(state.colors.map((color) => color.id));
  let pendingCopyKind = null;
  let copyState = null;
  let pageNotice = null;
  let dom = null;

  const clipboardApi = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const writeText = clipboardApi && typeof clipboardApi.writeText === "function"
    ? clipboardApi.writeText.bind(clipboardApi)
    : undefined;
  const clipboard = createClipboardController(writeText, (result) => {
    if (!pendingCopyKind) return;
    const kind = pendingCopyKind;
    pendingCopyKind = null;
    copyState = {
      kind,
      phase: result.ok ? "success" : "error",
      result,
    };
    renderFeedback();
    if (!result.ok) focusAndSelectFallback();
  });
  const downloadController = createBrowserDownloadController();
  const downloadSupported = typeof Blob === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof URL.revokeObjectURL === "function";

  function currentFocusKey() {
    const active = document.activeElement;
    return active && root.contains(active) ? active.dataset.focusKey ?? null : null;
  }

  function focusByKey(key) {
    if (!key) return;
    const candidates = root.querySelectorAll("[data-focus-key]");
    for (const candidate of candidates) {
      if (candidate.dataset.focusKey === key) {
        if (candidate.disabled) {
          const fallbackKey = candidate.dataset.id
            ? "swatch-" + candidate.dataset.id
            : "swatch-" + state.selectedId;
          if (fallbackKey !== key) focusByKey(fallbackKey);
          return;
        }
        try {
          candidate.focus({ preventScroll: true });
        } catch {
          candidate.focus();
        }
        return;
      }
    }
  }

  function renderAll(preferredFocusKey) {
    const restoreFocus = preferredFocusKey === undefined ? currentFocusKey() : preferredFocusKey;
    root.replaceChildren();
    dom = {};
    root.setAttribute("aria-label", t.appTitle);
    root.append(buildWorkspace());
    refreshPaletteValues();
    refreshEditor();
    refreshContrast();
    refreshCss();
    renderFeedback();
    renderNotice();
    focusByKey(restoreFocus);
  }

  function buildWorkspace() {
    const workspace = makeElement("div", "tool-workspace");
    const paletteSection = makeElement("section", "palette-section");
    paletteSection.setAttribute("aria-labelledby", "palette-title");

    const paletteHeading = makeElement("div", "section-heading");
    const paletteTitle = makeElement("h2", "", t.paletteTitle);
    paletteTitle.id = "palette-title";
    const paletteCopy = makeElement("p", "", t.paletteHint);
    const paletteTitleGroup = makeElement("div", "");
    paletteTitleGroup.append(paletteTitle, paletteCopy);
    const paletteActions = makeElement("div", "top-actions");
    dom.resetButton = makeButton(t.reset, "reset", "reset-button", {
      className: "reset-button",
    });
    dom.addButton = makeButton(t.addColor, "add", "add-color", { className: "accent" });
    dom.paletteCount = makeElement("span", "palette-count");
    paletteActions.append(dom.addButton, dom.resetButton);
    paletteHeading.append(paletteTitleGroup, paletteActions);
    dom.paletteList = makeElement("ul", "swatch-list");
    dom.paletteCount.setAttribute("aria-label", t.colorCount);
    paletteSection.append(paletteHeading, dom.paletteCount, dom.paletteList);

    const workGrid = makeElement("div", "work-grid");
    const editorPanel = makeElement("section", "work-panel editor-panel");
    editorPanel.setAttribute("aria-labelledby", "editor-title");
    const editorTitle = makeElement("h2", "", t.editTitle);
    editorTitle.id = "editor-title";
    const editorHeading = makeElement("div", "panel-heading");
    editorHeading.append(editorTitle, makeElement("p", "", t.editHelp));
    dom.selectedColorLine = makeElement("div", "selected-color-line");
    dom.modeSwitch = makeElement("div", "mode-switch");
    dom.modeSwitch.setAttribute("role", "group");
    dom.modeSwitch.setAttribute("aria-label", t.modeLabel);
    dom.fieldGrid = makeElement("div", "field-grid");
    dom.editorError = makeElement("p", "field-error");
    dom.editorError.id = "editor-error";
    dom.editorError.setAttribute("role", "alert");
    dom.editorState = makeElement("p", "editor-state");
    dom.editorState.setAttribute("role", "status");
    dom.editorState.setAttribute("aria-live", "polite");
    const editorActions = makeElement("div", "action-row editor-actions");
    dom.copySelectedButton = makeButton(t.copySelected, "copy-selected", "copy-selected", {
      className: "primary",
    });
    dom.copySelectedStatus = makeElement("p", "copy-status");
    dom.copySelectedStatus.setAttribute("role", "status");
    dom.copySelectedStatus.setAttribute("aria-live", "polite");
    editorActions.append(dom.copySelectedButton);
    dom.selectedFeedback = makeElement("div", "copy-feedback");
    editorPanel.append(
      editorHeading,
      dom.selectedColorLine,
      dom.modeSwitch,
      dom.fieldGrid,
      dom.editorError,
      dom.editorState,
      editorActions,
      dom.copySelectedStatus,
      dom.selectedFeedback,
    );

    const contrastPanel = makeElement("section", "work-panel contrast-panel");
    contrastPanel.setAttribute("aria-labelledby", "contrast-title");
    const contrastHeading = makeElement("div", "panel-heading");
    const contrastTitle = makeElement("h2", "", t.pairTitle);
    contrastTitle.id = "contrast-title";
    contrastHeading.append(contrastTitle);
    dom.pairControls = makeElement("div", "pair-controls");
    dom.swapButton = makeButton(t.swap, "swap", "swap-pair");
    dom.contrastResults = makeElement("div", "contrast-results");
    contrastPanel.append(contrastHeading, dom.pairControls, dom.swapButton, dom.contrastResults);

    workGrid.append(editorPanel, contrastPanel);

    const cssPanel = makeElement("section", "css-panel");
    cssPanel.setAttribute("aria-labelledby", "css-title");
    const cssHeading = makeElement("div", "panel-heading");
    const cssTitle = makeElement("h2", "", t.cssTitle);
    cssTitle.id = "css-title";
    cssHeading.append(cssTitle, makeElement("p", "", t.cssHint));
    dom.cssPreview = makeElement("pre", "css-preview");
    dom.cssPreview.setAttribute("aria-label", t.cssTitle);
    dom.cssPreview.setAttribute("role", "region");
    dom.cssPreview.tabIndex = 0;
    dom.copyCssButton = makeButton(t.copyCss, "copy-css", "copy-css", {
      className: "primary",
    });
    dom.copyCssStatus = makeElement("p", "copy-status");
    dom.copyCssStatus.setAttribute("role", "status");
    dom.copyCssStatus.setAttribute("aria-live", "polite");
    dom.downloadButton = makeButton(t.downloadCss, "download-css", "download-css", {
      className: "accent",
    });
    const cssActions = makeElement("div", "action-row");
    cssActions.append(dom.copyCssButton, dom.downloadButton);
    dom.cssNotice = makeElement("p", "css-empty");
    dom.cssNotice.setAttribute("role", "status");
    dom.cssNotice.setAttribute("aria-live", "polite");
    dom.cssFeedback = makeElement("div", "copy-feedback");
    cssPanel.append(cssHeading, dom.cssPreview, dom.cssNotice, cssActions, dom.copyCssStatus, dom.cssFeedback);

    const notice = makeElement("p", "notice-status");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    dom.pageNotice = notice;
    workspace.append(paletteSection, workGrid, cssPanel, notice);

    buildPaletteTiles();
    buildEditorFields();
    buildPairControls();
    return workspace;
  }

  function buildPaletteTiles() {
    dom.paletteList.replaceChildren();
    dom.paletteTiles = new Map();
    state.colors.forEach((color, index) => {
      const item = makeElement("li", "color-tile");
      item.dataset.colorId = color.id;
      const selectButton = makeButton("", "select-color", "swatch-" + color.id, {
        id: color.id,
        pressed: state.selectedId === color.id,
      });
      selectButton.className = "swatch-button";
      const swatchChip = makeElement("span", "swatch-chip");
      swatchChip.setAttribute("aria-hidden", "true");
      const swatchMeta = makeElement("span", "swatch-meta");
      const swatchName = makeElement("span", "swatch-name");
      const starting = makeElement("span", "starting-marker");
      const swatchValue = makeElement("code", "swatch-value");
      swatchMeta.append(swatchName, starting);
      selectButton.append(swatchChip, swatchMeta, swatchValue);
      const actions = makeElement("div", "swatch-actions");
      actions.append(
        makeButton(t.movePrevious, "move", "move-previous-" + color.id, {
          id: color.id,
          direction: "previous",
          disabled: index === 0,
          ariaLabel: t.movePrevious + " " + t.selectColor.toLowerCase() + " " + (index + 1),
        }),
        makeButton(t.moveNext, "move", "move-next-" + color.id, {
          id: color.id,
          direction: "next",
          disabled: index === state.colors.length - 1,
          ariaLabel: t.moveNext + " " + t.selectColor.toLowerCase() + " " + (index + 1),
        }),
        makeButton(t.removeColor, "remove", "remove-" + color.id, {
          id: color.id,
          className: "danger",
          disabled: state.colors.length <= 2,
          ariaLabel: t.removeColor + " " + t.selectColor.toLowerCase() + " " + (index + 1),
          title: state.colors.length <= 2 ? t.minColors : "",
        }),
      );
      item.append(selectButton, actions);
      dom.paletteList.append(item);
      dom.paletteTiles.set(color.id, { item, selectButton, swatchChip, swatchName, starting, swatchValue });
    });
    const addItem = makeElement("li", "add-tile");
    dom.paletteAddButton = makeButton(t.addColor, "add", "palette-add", {
      className: "palette-add",
      disabled: state.colors.length >= 8,
      title: state.colors.length >= 8 ? t.maxColors : "",
    });
    addItem.append(dom.paletteAddButton);
    dom.paletteList.append(addItem);
    dom.addButton.disabled = state.colors.length >= 8;
    dom.addButton.title = state.colors.length >= 8 ? t.maxColors : "";
  }

  function buildEditorFields() {
    const selectedColor = state.colors.find((color) => color.id === state.selectedId);
    const selectedDraft = state.drafts[state.selectedId];
    const ordinal = colorOrdinal(state, selectedColor.id);
    const hex = committedHex(selectedColor);
    dom.selectedColorLine.replaceChildren();
    dom.selectedChip = makeElement("span", "selected-chip");
    dom.selectedChip.setAttribute("aria-hidden", "true");
    const copy = makeElement("span", "selected-color-copy");
    dom.selectedLabel = makeElement("span", "");
    dom.selectedValue = makeElement("strong", "code-value");
    copy.append(dom.selectedLabel, dom.selectedValue);
    dom.selectedColorLine.append(dom.selectedChip, copy);

    dom.modeSwitch.replaceChildren();
    const modes = [
      ["hex", t.modeHex],
      ["rgb", t.modeRgb],
      ["hsl", t.modeHsl],
    ];
    for (const [mode, label] of modes) {
      dom.modeSwitch.append(makeButton(label, "mode", "mode-" + mode, {
        id: selectedColor.id,
        mode,
        pressed: selectedDraft.mode === mode,
      }));
    }

    dom.fieldGrid.className = "field-grid" + (selectedDraft.mode === "hex" ? " single-field" : "");
    dom.fieldGrid.replaceChildren();
    const labels = {
      hex: [["hex", t.fieldHex]],
      rgb: [["r", t.fieldR], ["g", t.fieldG], ["b", t.fieldB]],
      hsl: [["h", t.fieldH], ["s", t.fieldS], ["l", t.fieldL]],
    };
    for (const [field, label] of labels[selectedDraft.mode]) {
      const wrapper = makeElement("div", "field");
      const inputId = "color-" + selectedColor.id + "-" + field;
      const inputLabel = makeElement("label", "", label);
      inputLabel.htmlFor = inputId;
      const input = makeElement("input", "");
      input.id = inputId;
      input.type = "text";
      input.inputMode = field === "hex" ? "text" : "decimal";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = field === "hex" ? 32 : 8;
      input.value = selectedDraft.fields[field];
      input.dataset.colorField = "true";
      input.dataset.colorId = selectedColor.id;
      input.dataset.field = field;
      input.dataset.focusKey = "field-" + field;
      input.setAttribute("aria-describedby", "editor-error");
      wrapper.append(inputLabel, input);
      dom.fieldGrid.append(wrapper);
    }
    refreshEditor();
  }

  function buildPairControls() {
    dom.pairControls.replaceChildren();
    dom.foregroundSelect = makePairSelect("foreground", t.foreground, state.foregroundId);
    dom.backgroundSelect = makePairSelect("background", t.background, state.backgroundId);
    dom.pairControls.append(dom.foregroundSelect.wrapper, dom.backgroundSelect.wrapper);
  }

  function makePairSelect(name, label, selectedId) {
    const wrapper = makeElement("div", "pair-control");
    const selectId = name + "-select";
    const selectLabel = makeElement("label", "", label);
    selectLabel.htmlFor = selectId;
    const select = makeElement("select", "");
    select.id = selectId;
    select.dataset.action = "pair";
    select.dataset.pair = name;
    select.dataset.focusKey = name + "-select";
    select.setAttribute("aria-label", label);
    for (let index = 0; index < state.colors.length; index += 1) {
      const color = state.colors[index];
      const option = makeElement("option", "", (index + 1) + " · " + committedHex(color));
      option.value = color.id;
      option.selected = color.id === selectedId;
      select.append(option);
    }
    wrapper.append(selectLabel, select);
    return { wrapper, select };
  }

  function refreshPaletteValues() {
    if (!dom || !dom.paletteTiles) return;
    dom.paletteCount.textContent = state.colors.length + " / 8";
    for (let index = 0; index < state.colors.length; index += 1) {
      const color = state.colors[index];
      const tile = dom.paletteTiles.get(color.id);
      if (!tile) continue;
      const hex = committedHex(color);
      tile.item.dataset.selected = String(state.selectedId === color.id);
      tile.selectButton.setAttribute("aria-pressed", String(state.selectedId === color.id));
      tile.selectButton.setAttribute(
        "aria-label",
        t.selectColor + " " + (index + 1) + ", " + hex,
      );
      tile.swatchChip.style.backgroundColor = hex;
      setText(tile.swatchName, t.selectColor + " " + (index + 1));
      setText(tile.starting, startingColorIds.has(color.id) ? t.startingColor : "");
      setText(tile.swatchValue, hex);
    }
  }

  function refreshEditor() {
    if (!dom) return;
    const selectedColor = state.colors.find((color) => color.id === state.selectedId);
    const draft = state.drafts[state.selectedId];
    if (!selectedColor || !draft) return;
    const ordinal = colorOrdinal(state, state.selectedId);
    const hex = committedHex(selectedColor);
    dom.selectedChip.style.backgroundColor = hex;
    setText(dom.selectedLabel, t.selectedColor + " " + ordinal);
    setText(dom.selectedValue, hex);
    for (const modeButton of dom.modeSwitch.querySelectorAll("button[data-mode]")) {
      modeButton.setAttribute("aria-pressed", String(modeButton.dataset.mode === draft.mode));
    }
    if (dom.editorError) {
      dom.editorError.hidden = draft.error === null;
      setText(dom.editorError, editorErrorText(draft));
    }
    const stateKey = draft.error !== null ? "invalid" : draft.dirty ? "editing" : "ready";
    dom.editorState.dataset.state = stateKey;
    const editorText = draft.error !== null
      ? t.draftInvalid
      : draft.dirty
        ? t.draftPending
        : t.draftReady;
    setText(dom.editorState, editorText);
    dom.copySelectedButton.disabled = draft.error !== null || draft.dirty;
    for (const input of dom.fieldGrid.querySelectorAll("input[data-color-field]")) {
      const fields = draft.fields;
      if (input.value !== fields[input.dataset.field]) {
        input.value = fields[input.dataset.field];
      }
      input.setAttribute("aria-invalid", String(draft.error !== null));
    }
  }

  function editorErrorText(draft) {
    if (draft.error === "VALUE_OUT_OF_RANGE") {
      return draft.mode === "rgb" ? t.errorRangeRgb : t.errorRangeHsl;
    }
    return draft.mode === "hex" ? t.errorHex : t.errorNumber;
  }

  function refreshContrast() {
    if (!dom) return;
    const foreground = state.colors.find((color) => color.id === state.foregroundId);
    const background = state.colors.find((color) => color.id === state.backgroundId);
    const foregroundDraft = state.drafts[state.foregroundId];
    const backgroundDraft = state.drafts[state.backgroundId];
    const results = dom.contrastResults;
    results.replaceChildren();

    if (foregroundDraft.error !== null || backgroundDraft.error !== null) {
      results.append(makeElement("p", "contrast-unavailable", t.contrastFix));
      return;
    }
    if (foregroundDraft.dirty || backgroundDraft.dirty) {
      results.append(makeElement("p", "contrast-unavailable", t.contrastCommit));
      return;
    }

    const ratio = contrastRatio(
      { r: foreground.r, g: foreground.g, b: foreground.b },
      { r: background.r, g: background.g, b: background.b },
    );
    const evaluation = evaluateContrast(ratio);
    const sample = makeElement("div", "contrast-sample");
    sample.style.color = committedHex(foreground);
    sample.style.backgroundColor = committedHex(background);
    sample.setAttribute("aria-label", t.sampleCaption);
    sample.append(makeElement("p", "", t.sampleText));
    sample.append(makeElement(
      "code",
      "",
      t.foreground + " " + committedHex(foreground) + " · " +
        t.background + " " + committedHex(background),
    ));
    const ratioLine = makeElement("p", "ratio-line");
    ratioLine.append(
      makeElement("span", "", t.ratioLabel),
      makeElement("strong", "ratio-value", ratio.toFixed(2) + ":1"),
    );
    const thresholdList = makeElement("ul", "threshold-list");
    const thresholds = [
      [t.normalAA, evaluation.normalAA],
      [t.normalAAA, evaluation.normalAAA],
      [t.largeAA, evaluation.largeAA],
      [t.largeAAA, evaluation.largeAAA],
    ];
    for (const [label, passed] of thresholds) {
      const row = makeElement("li", "threshold-row");
      row.append(
        makeElement("span", "", label),
        makeElement("span", "threshold-result " + (passed ? "pass" : "fail"),
          passed ? t.pass : t.fail),
      );
      thresholdList.append(row);
    }
    const note = makeElement("p", "contrast-note", t.contrastOnly + " " + t.largeTextHelp);
    results.append(
      makeElement("p", "sample-caption", t.sampleCaption),
      sample,
      ratioLine,
      thresholdList,
      note,
    );
  }

  function refreshPairOptionLabels() {
    for (const select of [dom.foregroundSelect.select, dom.backgroundSelect.select]) {
      for (const option of select.options) {
        const color = state.colors.find((item) => item.id === option.value);
        if (!color) continue;
        setText(option, colorOrdinal(state, color.id) + " · " + committedHex(color));
      }
    }
  }

  function cssTextForState() {
    if (isPaletteDirty(state)) return null;
    const projectedColors = state.colors.map((color) => ({
      r: color.r,
      g: color.g,
      b: color.b,
    }));
    return exportCss(projectedColors);
  }

  function refreshCss() {
    if (!dom) return;
    const css = cssTextForState();
    const dirty = css === null;
    dom.cssPreview.replaceChildren();
    if (dirty) {
      dom.cssPreview.hidden = true;
      dom.cssNotice.hidden = false;
      setText(dom.cssNotice, t.cssPending);
    } else {
      dom.cssPreview.hidden = false;
      dom.cssNotice.hidden = true;
      const code = makeElement("code", "", css);
      dom.cssPreview.append(code);
    }
    dom.copyCssButton.disabled = dirty;
    dom.downloadButton.disabled = dirty || !downloadSupported;
    if (!downloadSupported && !dirty) {
      setText(dom.cssNotice, t.downloadFailed);
      dom.cssNotice.hidden = false;
    }
  }

  function renderFeedback() {
    if (!dom) return;
    dom.selectedFeedback.replaceChildren();
    dom.cssFeedback.replaceChildren();
    dom.copySelectedStatus.textContent = "";
    dom.copyCssStatus.textContent = "";
    if (!copyState) return;

    const isCss = copyState.kind === "css";
    const statusNode = isCss ? dom.copyCssStatus : dom.copySelectedStatus;
    const feedback = isCss ? dom.cssFeedback : dom.selectedFeedback;
    const message = copyState.phase === "pending"
      ? (isCss ? t.cssCopying : t.selectedCopying)
      : copyState.phase === "success"
        ? (isCss ? t.cssCopied : t.selectedCopied)
        : t.copyDenied;
    statusNode.dataset.kind = copyState.phase === "error"
      ? "error"
      : copyState.phase === "success"
        ? "success"
        : "pending";
    setText(statusNode, message);
    if (copyState.phase === "error") {
      const label = makeElement("label", "sr-only", t.fallbackLabel);
      const textarea = makeElement("textarea", "copy-fallback");
      textarea.readOnly = true;
      textarea.rows = 3;
      textarea.value = copyState.result.text;
      textarea.dataset.focusKey = isCss ? "fallback-css" : "fallback-selected";
      textarea.setAttribute("aria-label", t.fallbackLabel);
      feedback.append(label, textarea);
      label.htmlFor = textarea.id = isCss ? "copy-css-fallback" : "copy-selected-fallback";
    }
  }

  function focusAndSelectFallback() {
    const key = copyState && copyState.kind === "css" ? "fallback-css" : "fallback-selected";
    const candidates = root.querySelectorAll("textarea[data-focus-key]");
    for (const candidate of candidates) {
      if (candidate.dataset.focusKey === key) {
        candidate.focus();
        candidate.select();
        return;
      }
    }
  }

  function renderNotice() {
    if (!dom) return;
    setText(dom.pageNotice, pageNotice ?? "");
    dom.pageNotice.hidden = !pageNotice;
  }

  function invalidateOutputs() {
    clipboard.invalidate();
    downloadController.invalidate();
    pendingCopyKind = null;
    copyState = null;
    pageNotice = null;
  }

  function refreshAfterDraftChange() {
    refreshPaletteValues();
    refreshEditor();
    refreshPairOptionLabels();
    refreshContrast();
    refreshCss();
    renderFeedback();
    renderNotice();
  }

  function updateStateOnly(action) {
    const result = reducePalette(state, action);
    if (!result.ok) return result;
    if (result.value !== state) {
      state = result.value;
      invalidateOutputs();
    }
    return result;
  }

  function dispatch(action, focusAfter, noticeAfter) {
    const result = updateStateOnly(action);
    if (!result.ok) {
      pageNotice = result.code === "PALETTE_LIMIT" && action.type === "add"
        ? t.maxColors
        : result.code === "PALETTE_LIMIT"
          ? t.minColors
          : "";
      renderAll(currentFocusKey());
      return result;
    }
    if (action.type === "reset") {
      startingColorIds = new Set(state.colors.map((color) => color.id));
    }
    if (noticeAfter) pageNotice = noticeAfter;
    const focusKey = typeof focusAfter === "function" ? focusAfter(state) : focusAfter;
    renderAll(focusKey);
    return result;
  }

  function collectEditorFields(colorId) {
    const fields = {};
    for (const input of dom.fieldGrid.querySelectorAll("input[data-color-field]")) {
      if (input.dataset.colorId === colorId) fields[input.dataset.field] = input.value;
    }
    return fields;
  }

  function updateDraftFromInput(input) {
    const id = input.dataset.colorId;
    const result = updateStateOnly({
      type: "update",
      id,
      operation: "draft",
      fields: collectEditorFields(id),
    });
    if (result.ok) refreshAfterDraftChange();
  }

  function commitColor(id) {
    const result = updateStateOnly({ type: "update", id, operation: "commit" });
    if (!result.ok) return;
    if (result.value !== state) return;
    refreshAfterDraftChange();
  }

  function formatSelectedColor() {
    const color = state.colors.find((item) => item.id === state.selectedId);
    const rgb = { r: color.r, g: color.g, b: color.b };
    const mode = state.drafts[state.selectedId].mode;
    if (mode === "rgb") return formatRgb(rgb);
    if (mode === "hsl") return formatHsl(rgb);
    return formatHex(rgb);
  }

  function beginCopy(kind, safeText) {
    pendingCopyKind = kind;
    copyState = { kind, phase: "pending" };
    pageNotice = null;
    renderFeedback();
    renderNotice();
    clipboard.copy(safeText);
  }

  function beginCssCopy() {
    const css = cssTextForState();
    if (css === null) return;
    downloadController.invalidate();
    beginCopy("css", css);
  }

  function beginSelectedCopy() {
    const draft = state.drafts[state.selectedId];
    if (draft.error !== null || draft.dirty) return;
    beginCopy("selected", formatSelectedColor());
  }

  function beginDownload() {
    const css = cssTextForState();
    if (css === null || !downloadSupported) return;
    try {
      const result = downloadController.download(css);
      pageNotice = result.ok ? t.downloadDone : t.downloadFailed;
    } catch {
      pageNotice = t.downloadFailed;
    }
    renderNotice();
  }

  function actionButtonClick(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === "reset") {
      const result = dispatch({ type: "reset" }, "reset-button", t.resetDone);
      if (!result.ok) return;
      return;
    }
    if (action === "add") {
      const result = updateStateOnly({ type: "add" });
      if (!result.ok) {
        pageNotice = t.maxColors;
        renderAll(button.dataset.focusKey);
        return;
      }
      renderAll("swatch-" + state.selectedId);
      return;
    }
    if (action === "select-color") {
      dispatch({
        type: "select-pair",
        selectedId: id,
        foregroundId: state.foregroundId,
        backgroundId: state.backgroundId,
      }, "swatch-" + id);
      return;
    }
    if (action === "move") {
      dispatch({ type: "move", id, direction: button.dataset.direction }, button.dataset.focusKey);
      return;
    }
    if (action === "remove") {
      const result = updateStateOnly({ type: "remove", id });
      if (!result.ok) {
        pageNotice = result.code === "PALETTE_LIMIT" ? t.minColors : "";
        renderAll("swatch-" + (state.selectedId));
        return;
      }
      renderAll("swatch-" + state.selectedId);
      return;
    }
    if (action === "mode") {
      const draft = state.drafts[id];
      if (draft.mode === button.dataset.mode) return;
      dispatch({
        type: "update",
        id,
        operation: "mode",
        mode: button.dataset.mode,
      }, button.dataset.focusKey);
      return;
    }
    if (action === "swap") {
      dispatch({ type: "swap" }, button.dataset.focusKey);
      return;
    }
    if (action === "copy-selected") {
      beginSelectedCopy();
      return;
    }
    if (action === "copy-css") {
      beginCssCopy();
      return;
    }
    if (action === "download-css") beginDownload();
  }

  function onClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || !root.contains(button) || button.disabled) return;
    actionButtonClick(button);
  }

  function onInput(event) {
    const input = event.target;
    if (!input.matches("input[data-color-field]")) return;
    updateDraftFromInput(input);
  }

  function onFocusOut(event) {
    const input = event.target;
    if (!input.matches("input[data-color-field]")) return;
    commitColor(input.dataset.colorId);
  }

  function onKeyDown(event) {
    const input = event.target;
    if (event.key !== "Enter" || !input.matches("input[data-color-field]")) return;
    event.preventDefault();
    commitColor(input.dataset.colorId);
  }

  function onChange(event) {
    const select = event.target;
    if (!select.matches("select[data-action='pair']")) return;
    const pair = select.dataset.pair;
    const foregroundId = pair === "foreground" ? select.value : state.foregroundId;
    const backgroundId = pair === "background" ? select.value : state.backgroundId;
    dispatch({
      type: "select-pair",
      selectedId: state.selectedId,
      foregroundId,
      backgroundId,
    }, pair + "-select");
  }

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("change", onChange);

  window.addEventListener("pagehide", () => {
    clipboard.invalidate();
    downloadController.invalidate();
    pendingCopyKind = null;
    copyState = null;
    pageNotice = null;
    renderFeedback();
    renderNotice();
  });

  renderAll(null);
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#palette-app");
  if (root) bootPalette(root);
}
