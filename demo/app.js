import {
  CloudRenderer,
  createSharedCamera,
  drawSpectrum,
} from "./renderer.js";

const librarySpecifier = new URL(import.meta.url).pathname.includes("/demo/")
  ? "../javascript/cpos.js"
  : "./javascript/cpos.js";
const { decodeCpos } = await import(librarySpecifier);

const elements = {
  body: document.body,
  dropZone: document.getElementById("drop-zone"),
  fileInput: document.getElementById("file-input"),
  chooseFile: document.getElementById("choose-file"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
  cposStats: document.getElementById("cpos-stats"),
  cposEmpty: document.getElementById("cpos-empty"),
  spectrum: document.getElementById("spectrum"),
  credit: document.getElementById("example-credit"),
};

const renderer = new CloudRenderer(
  document.getElementById("cpos-cloud"),
  createSharedCamera(),
);

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

function setBusy(busy) {
  elements.body.classList.toggle("busy", busy);
  elements.chooseFile.disabled = busy;
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

async function loadExample() {
  try {
    const [metadataResponse, payloadResponse] = await Promise.all([
      fetch("data/example.json"),
      fetch("data/example.cpos"),
    ]);
    if (!metadataResponse.ok || !payloadResponse.ok) {
      throw new Error("public example is unavailable");
    }
    const metadata = await metadataResponse.json();
    const payload = await payloadResponse.arrayBuffer();
    showDecoded(await decodeCpos(payload));
    elements.status.textContent = `${metadata.title} CPOS beta example`;
    elements.summary.textContent = (
      `${formatBytes(metadata.original_size_bytes)} → `
      + `${formatBytes(metadata.cpos_size_bytes)} · `
      + `${metadata.compression_ratio.toFixed(1)}× smaller`
    );
    elements.credit.textContent = (
      `Public example: ${metadata.title} · Zenodo 7979668 · ${metadata.license}`
    );
  } catch (error) {
    elements.status.textContent = error.message;
    elements.cposEmpty.textContent = "example unavailable";
  }
}

async function processCpos(file) {
  if (!file.name.toLowerCase().endsWith(".cpos")) {
    elements.status.textContent = "Choose a CPOS beta file.";
    return;
  }
  setBusy(true);
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

elements.chooseFile.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) processCpos(file);
  elements.fileInput.value = "";
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
  if (file) processCpos(file);
});

loadExample();
