const denied = (text) => ({ ok: false, code: "COPY_DENIED", text });
const copied = (text) => ({ ok: true, text });

export function createClipboardController(writeText, onStatus) {
  let epoch = 0;
  const notify = typeof onStatus === "function" ? onStatus : () => {};

  function publishIfCurrent(requestEpoch, result) {
    if (requestEpoch === epoch) {
      try {
        notify(result);
      } catch {
        // A UI status callback must not change the clipboard operation result.
      }
    }
    return result;
  }

  function copy(text) {
    const requestEpoch = ++epoch;
    const safeText = typeof text === "string" ? text : "";
    if (typeof text !== "string" || typeof writeText !== "function") {
      return Promise.resolve(publishIfCurrent(requestEpoch, denied(safeText)));
    }

    let pending;
    try {
      pending = writeText(text);
    } catch {
      return Promise.resolve(publishIfCurrent(requestEpoch, denied(text)));
    }

    return Promise.resolve(pending).then(
      () => publishIfCurrent(requestEpoch, copied(text)),
      () => publishIfCurrent(requestEpoch, denied(text)),
    );
  }

  function invalidate() {
    epoch += 1;
  }

  return { copy, invalidate };
}

export function createDownloadController({
  createBlob,
  createObjectURL,
  revokeObjectURL,
  triggerDownload,
} = {}) {
  if (
    typeof createBlob !== "function" ||
    typeof createObjectURL !== "function" ||
    typeof revokeObjectURL !== "function" ||
    typeof triggerDownload !== "function"
  ) {
    throw new TypeError("Download actions require explicit browser adapters.");
  }

  let currentUrl = null;

  function releaseCurrentUrl() {
    const previousUrl = currentUrl;
    currentUrl = null;
    if (previousUrl !== null) {
      try {
        revokeObjectURL(previousUrl);
      } catch {
        // Revocation is best-effort during a later state change or page exit.
      }
    }
  }

  function invalidate() {
    releaseCurrentUrl();
  }

  function download(text) {
    if (typeof text !== "string") {
      throw new RangeError("CSS downloads require a string generated from committed colors.");
    }
    releaseCurrentUrl();
    const blob = createBlob(text);
    const objectUrl = createObjectURL(blob);
    if (typeof objectUrl !== "string" || objectUrl.length === 0) {
      throw new RangeError("The download adapter did not return an object URL.");
    }

    currentUrl = objectUrl;
    try {
      triggerDownload(objectUrl, "palette.css");
      return { ok: true, filename: "palette.css" };
    } catch (error) {
      if (currentUrl === objectUrl) releaseCurrentUrl();
      throw error;
    }
  }

  return { download, invalidate };
}
