import assert from "node:assert/strict";
import test from "node:test";
import {
  createClipboardController,
  createDownloadController,
} from "../public/js/clipboard.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("clipboard adapter runs only on explicit copy and reports current success", async () => {
  const pending = deferred();
  const calls = [];
  const statuses = [];
  const controller = createClipboardController((text) => {
    calls.push(text);
    return pending.promise;
  }, (status) => statuses.push(status));

  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(statuses, []);
  const resultPromise = controller.copy("#AA33FF");
  assert.deepStrictEqual(calls, ["#AA33FF"]);
  assert.deepStrictEqual(statuses, []);
  pending.resolve();
  assert.deepStrictEqual(await resultPromise, { ok: true, text: "#AA33FF" });
  assert.deepStrictEqual(statuses, [{ ok: true, text: "#AA33FF" }]);
});

test("synchronous throw, Promise rejection, and missing adapter return COPY_DENIED with manual text", async () => {
  const syncStatuses = [];
  const synchronous = createClipboardController(() => {
    throw new Error("adapter failure details are not exposed");
  }, (status) => syncStatuses.push(status));
  assert.deepStrictEqual(await synchronous.copy("rgb(1, 2, 3)"), {
    ok: false,
    code: "COPY_DENIED",
    text: "rgb(1, 2, 3)",
  });
  assert.deepStrictEqual(syncStatuses, [{ ok: false, code: "COPY_DENIED", text: "rgb(1, 2, 3)" }]);

  const rejectedStatuses = [];
  const rejected = createClipboardController(() => Promise.reject(new Error("secret adapter detail")), (status) => {
    rejectedStatuses.push(status);
  });
  assert.deepStrictEqual(await rejected.copy("hsl(120, 100%, 50%)"), {
    ok: false,
    code: "COPY_DENIED",
    text: "hsl(120, 100%, 50%)",
  });
  assert.deepStrictEqual(rejectedStatuses, [{
    ok: false,
    code: "COPY_DENIED",
    text: "hsl(120, 100%, 50%)",
  }]);

  const missingStatuses = [];
  const missing = createClipboardController(undefined, (status) => missingStatuses.push(status));
  assert.deepStrictEqual(await missing.copy(":root {}\n"), {
    ok: false,
    code: "COPY_DENIED",
    text: ":root {}\n",
  });
  assert.deepStrictEqual(missingStatuses, [{ ok: false, code: "COPY_DENIED", text: ":root {}\n" }]);
});

test("out-of-order results from older copies do not notify status", async () => {
  const pending = [];
  const statuses = [];
  const controller = createClipboardController((text) => {
    const next = deferred();
    pending.push({ text, ...next });
    return next.promise;
  }, (status) => statuses.push(status));

  const olderCopy = controller.copy("old palette text");
  const newerCopy = controller.copy("new palette text");
  pending[1].resolve();
  assert.deepStrictEqual(await newerCopy, { ok: true, text: "new palette text" });
  pending[0].reject(new Error("old failure"));
  assert.deepStrictEqual(await olderCopy, {
    ok: false,
    code: "COPY_DENIED",
    text: "old palette text",
  });
  assert.deepStrictEqual(statuses, [{ ok: true, text: "new palette text" }]);
});

test("invalidate suppresses pending clipboard success and failure notifications", async () => {
  const successPending = deferred();
  const failurePending = deferred();
  const nextPending = [successPending, failurePending];
  const statuses = [];
  const controller = createClipboardController(() => nextPending.shift().promise, (status) => {
    statuses.push(status);
  });

  const staleSuccess = controller.copy("old CSS");
  controller.invalidate();
  successPending.resolve();
  assert.deepStrictEqual(await staleSuccess, { ok: true, text: "old CSS" });
  assert.deepStrictEqual(statuses, []);

  const staleFailure = controller.copy("another CSS value");
  controller.invalidate();
  failurePending.reject(new Error("denied"));
  assert.deepStrictEqual(await staleFailure, {
    ok: false,
    code: "COPY_DENIED",
    text: "another CSS value",
  });
  assert.deepStrictEqual(statuses, []);
});

test("non-string copy input is denied without calling the injected adapter", async () => {
  let calls = 0;
  const statuses = [];
  const controller = createClipboardController(() => {
    calls += 1;
  }, (status) => statuses.push(status));

  assert.deepStrictEqual(await controller.copy(123), { ok: false, code: "COPY_DENIED", text: "" });
  assert.equal(calls, 0);
  assert.deepStrictEqual(statuses, [{ ok: false, code: "COPY_DENIED", text: "" }]);
});

test("CSS download controller uses the fixed file name and keeps each object URL until invalidated", () => {
  const events = [];
  let sequence = 0;
  const controller = createDownloadController({
    createBlob(text) {
      const blob = { text, type: "text/css;charset=utf-8" };
      events.push(["blob", blob]);
      return blob;
    },
    createObjectURL(blob) {
      sequence += 1;
      const url = "blob:palette-" + sequence;
      events.push(["create", url, blob]);
      return url;
    },
    revokeObjectURL(url) {
      events.push(["revoke", url]);
    },
    triggerDownload(url, filename) {
      events.push(["download", url, filename]);
    },
  });
  const css = ":root {\n  --color-1: #111410;\n  --color-2: #F3F0E8;\n}\n";

  assert.deepStrictEqual(controller.download(css), { ok: true, filename: "palette.css" });
  assert.deepStrictEqual(events, [
    ["blob", { text: css, type: "text/css;charset=utf-8" }],
    ["create", "blob:palette-1", { text: css, type: "text/css;charset=utf-8" }],
    ["download", "blob:palette-1", "palette.css"],
  ]);

  controller.download(css);
  assert.deepStrictEqual(events.slice(3, 7), [
    ["revoke", "blob:palette-1"],
    ["blob", { text: css, type: "text/css;charset=utf-8" }],
    ["create", "blob:palette-2", { text: css, type: "text/css;charset=utf-8" }],
    ["download", "blob:palette-2", "palette.css"],
  ]);
  controller.invalidate();
  controller.invalidate();
  assert.deepStrictEqual(events.slice(7), [["revoke", "blob:palette-2"]]);
  assert.throws(() => controller.download({ arbitrary: "content" }), RangeError);
});

test("a failed download trigger revokes the newly created URL", () => {
  const events = [];
  const controller = createDownloadController({
    createBlob: (text) => ({ text }),
    createObjectURL: () => "blob:failed",
    revokeObjectURL: (url) => events.push(["revoke", url]),
    triggerDownload: () => {
      throw new Error("browser details are not exposed");
    },
  });

  assert.throws(() => controller.download(":root {}\n"), /browser details are not exposed/u);
  assert.deepStrictEqual(events, [["revoke", "blob:failed"]]);
});
