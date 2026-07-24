const librarySpecifier = new URL(import.meta.url).pathname.includes("/demo/")
  ? "../javascript/encoder.js"
  : "./javascript/encoder.js";
const { encodePos } = await import(librarySpecifier);

self.onmessage = async (event) => {
  const { buffer, targetPoints } = event.data;
  try {
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
