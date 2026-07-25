import {
  CloudRenderer,
  createSharedCamera,
  drawSpectrum,
} from "./renderer.js";

const librarySpecifier = new URL(import.meta.url).pathname.includes("/demo/")
  ? "../javascript/cpos.js"
  : "./javascript/cpos.js";
const { decodeCpos, inspectCpos } = await import(librarySpecifier);

const TARGET_POINTS = 4_000_000;
const elements = {
  body: document.body,
  dropZone: document.getElementById("drop-zone"),
  fileInput: document.getElementById("file-input"),
  chooseFile: document.getElementById("choose-file"),
  download: document.getElementById("download"),
  progress: document.getElementById("progress"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
  cposStats: document.getElementById("cpos-stats"),
  cposEmpty: document.getElementById("cpos-empty"),
  spectrum: document.getElementById("spectrum"),
};

const renderer = new CloudRenderer(
  document.getElementById("cpos-cloud"),
  createSharedCamera(),
);

let busy = false;
let downloadUrl = null;
let downloadName = "converted.cpos";

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function setBusy(value) {
  busy = value;
  elements.body.classList.toggle("busy", value);
  elements.chooseFile.disabled = value;
}

function setProgress(stage, fraction) {
  elements.progress.hidden = false;
  elements.progress.value = fraction;
  elements.status.textContent = stage;
}

function hideProgress() {
  elements.progress.hidden = true;
  elements.progress.value = 0;
}

function clearDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  elements.download.disabled = true;
}

function setDownload(payload, sourceName) {
  clearDownload();
  const blob = new Blob([payload], { type: "application/octet-stream" });
  downloadUrl = URL.createObjectURL(blob);
  downloadName = sourceName.replace(/\.pos$/i, "") + ".cpos";
  elements.download.disabled = false;
}

function coarseCounts(payload, header, offset) {
  const view = new DataView(payload);
  const counts = new Uint32Array(header.spectrumBinCount);
  for (let index = 0; index < counts.length; index += 1) {
    counts[index] = view.getUint32(offset + index * 4, true);
  }
  return counts;
}

function showHeader(payload, header, { previewAvailable }) {
  const trueCounts = coarseCounts(payload, header, header.trueCountsOffset);
  const storedCounts = coarseCounts(payload, header, header.storedCountsOffset);
  elements.cposStats.textContent = (
    `${formatInteger(header.originalPointCount)} ions · `
    + `${formatInteger(header.storedPointCount)} seeds · `
    + `${formatInteger(header.exactPointCount)} rare tuples`
  );
  drawSpectrum(elements.spectrum, trueCounts, storedCounts, {
    binWidth: header.spectrumBinDa,
  });
  if (!previewAvailable) {
    renderer.clear();
    elements.cposEmpty.hidden = false;
    elements.cposEmpty.textContent = "conversion complete · download ready";
  }
}

function showDecoded(decoded) {
  renderer.setPoints(decoded.points);
  elements.cposEmpty.hidden = true;
  elements.cposStats.textContent = (
    `${formatInteger(decoded.header.originalPointCount)} ions · `
    + `${formatInteger(decoded.header.storedPointCount)} seeds · `
    + `${formatInteger(decoded.header.exactPointCount)} rare tuples`
  );
  drawSpectrum(elements.spectrum, decoded.trueCounts, decoded.storedCounts, {
    binWidth: decoded.header.spectrumBinDa,
  });
}

async function encodePosFile(file) {
  setBusy(true);
  clearDownload();
  elements.summary.textContent = formatBytes(file.size);
  setProgress(`Starting encoder for ${file.name}…`, 0);
  const started = performance.now();
  let worker;
  try {
    worker = new Worker(
      new URL("./encoder.worker.js?stall-fix=1", import.meta.url),
      { type: "module" },
    );
    const payload = await new Promise((resolve, reject) => {
      let startedWorker = false;
      let settled = false;
      let lastActivity = performance.now();
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        callback(value);
      };
      const watchdog = setInterval(() => {
        if (performance.now() - lastActivity > 60_000) {
          finish(
            reject,
            new Error(
              "The encoder stopped responding. Reload the page and try again.",
            ),
          );
        }
      }, 5_000);
      worker.onmessage = (event) => {
        lastActivity = performance.now();
        if (event.data.type === "ready") {
          if (startedWorker) return;
          startedWorker = true;
          setProgress(`Loading ${file.name} into the encoder…`, 0.001);
          worker.postMessage({ file, targetPoints: TARGET_POINTS });
        } else if (event.data.type === "progress") {
          setProgress(event.data.stage, event.data.fraction);
        } else if (event.data.type === "result") {
          finish(resolve, event.data.payload);
        } else if (event.data.type === "error") {
          finish(reject, new Error(event.data.message));
        }
      };
      worker.onerror = (event) => {
        finish(
          reject,
          new Error(event.message || "CPOS encoder worker failed to load"),
        );
      };
      worker.onmessageerror = () => {
        finish(
          reject,
          new Error("The browser could not send the POS file to the encoder"),
        );
      };
    });
    const header = inspectCpos(payload);
    setDownload(payload, file.name);
    showHeader(payload, header, { previewAvailable: false });
    const elapsed = (performance.now() - started) / 1000;
    elements.status.textContent = `${downloadName} is ready to download`;
    elements.summary.textContent = (
      `${formatBytes(file.size)} → ${formatBytes(payload.byteLength)} · `
      + `${elapsed.toFixed(1)} s`
    );
  } catch (error) {
    console.error(error);
    elements.status.textContent = error.message || "Encoding failed.";
    elements.summary.textContent = "";
  } finally {
    worker?.terminate();
    hideProgress();
    setBusy(false);
  }
}

async function processCpos(file) {
  setBusy(true);
  clearDownload();
  elements.status.textContent = `Decoding ${file.name}…`;
  elements.summary.textContent = "";
  try {
    const payload = await file.arrayBuffer();
    const started = performance.now();
    const decoded = await decodeCpos(payload);
    showDecoded(decoded);
    const elapsed = (performance.now() - started) / 1000;
    elements.status.textContent = `${file.name} decoded in ${elapsed.toFixed(2)} s`;
    elements.summary.textContent = (
      `${formatBytes(payload.byteLength)} · `
      + `${formatInteger(decoded.header.originalPointCount)} ions`
    );
  } catch (error) {
    console.error(error);
    elements.status.textContent = error.message || "Decoding failed.";
  } finally {
    setBusy(false);
  }
}

function processFile(file) {
  if (busy) return;
  if (/\.pos$/i.test(file.name)) {
    encodePosFile(file);
  } else if (/\.cpos$/i.test(file.name)) {
    processCpos(file);
  } else {
    elements.status.textContent = "Choose a four-column .pos or CPOS beta file.";
  }
}

elements.chooseFile.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) processFile(file);
  elements.fileInput.value = "";
});

elements.download.addEventListener("click", () => {
  if (!downloadUrl) return;
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = downloadName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) processFile(file);
});

window.addEventListener("beforeunload", clearDownload);
