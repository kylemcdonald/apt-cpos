const librarySpecifier = new URL(import.meta.url).pathname.includes("/demo/")
  ? "../javascript/encoder.js"
  : "./javascript/encoder.js";
const { encodePos } = await import(librarySpecifier);

self.postMessage({ type: "ready" });

self.onmessage = async (event) => {
  const { file, targetPoints } = event.data;
  try {
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new Error("encoder worker expected a POS File");
    }
    self.postMessage({
      type: "progress",
      stage: `Loading ${file.name} into the encoder…`,
      fraction: 0.002,
    });
    const buffer = await file.arrayBuffer();
    self.postMessage({
      type: "progress",
      stage: `Loaded ${file.name} · starting CPOS encoding`,
      fraction: 0.005,
    });
    const payload = await encodePos(buffer, {
      targetPoints,
      onProgress: (stage, fraction) => {
        self.postMessage({ type: "progress", stage, fraction });
      },
    });
    self.postMessage(
      { type: "result", payload: payload.buffer },
      [payload.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.stack ?? String(error),
    });
  }
};
