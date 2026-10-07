import assert from "node:assert/strict";
import test from "node:test";
import { getMessages, SUPPORTED_LOCALES, TRANSLATIONS } from "../public/js/i18n.mjs";

test("Chinese and English UI dictionaries cover the same non-empty message contract", () => {
  assert.deepEqual(SUPPORTED_LOCALES, ["zh-Hant", "en"]);
  const chineseKeys = Object.keys(TRANSLATIONS["zh-Hant"]).sort();
  const englishKeys = Object.keys(TRANSLATIONS.en).sort();
  assert.deepEqual(englishKeys, chineseKeys);

  for (const locale of SUPPORTED_LOCALES) {
    const messages = getMessages(locale);
    assert.equal(Object.isFrozen(messages), true);
    for (const key of chineseKeys) {
      assert.equal(typeof messages[key], "string", locale + " has a string for " + key);
      assert.ok(messages[key].trim().length > 0, locale + " has text for " + key);
    }
  }
});

test("each locale clearly describes reset behavior, contrast limits, and manual copy recovery", () => {
  const requiredMessages = [
    "languageResetNotice",
    "resetDone",
    "copyDenied",
    "contrastOnly",
    "largeTextHelp",
    "privacyText",
  ];
  for (const locale of SUPPORTED_LOCALES) {
    const messages = getMessages(locale);
    for (const key of requiredMessages) {
      assert.ok(messages[key].length >= 8, locale + " explains " + key);
    }
  }
  assert.match(getMessages("zh-Hant").languageResetNotice, /未保存/u);
  assert.match(getMessages("en").languageResetNotice, /unsaved/u);
  assert.match(getMessages("zh-Hant").contrastOnly, /不代表整頁/u);
  assert.match(getMessages("en").contrastOnly, /does not certify the whole page/u);
  assert.equal(getMessages("unsupported"), getMessages("zh-Hant"));
});
