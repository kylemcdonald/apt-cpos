import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as cpos from "./cpos.js";
import { encodePos } from "./encoder.js";

function fixturePos(count = 20_000) {
  const buffer = new ArrayBuffer(count * 16);
  const view = new DataView(buffer);
  for (let point = 0; point < count; point += 1) {
    const offset = point * 16;
    view.setFloat32(offset, Math.sin(point * 0.013) * 20, false);
    view.setFloat32(offset + 4, Math.cos(point * 0.007) * 15, false);
    view.setFloat32(offset + 8, point * 0.002, false);
    const selector = point % 200;
    const center = point === 0 ? 68.9 : selector < 60 ? 55.94 : 27.98;
    view.setFloat32(
      offset + 12,
      center + ((point % 9) - 4) * 0.003,
      false,
    );
  }
  return buffer;
}

test("CPOS beta exposes the current encoder and decoder surfaces", () => {
  assert.deepEqual(cpos.CONTAINER_VERSION, [1, 0]);
  assert.deepEqual(cpos.ALGORITHM_VERSION, [1, 0, 0]);
  assert.equal(cpos.samplePosBySpectrum, undefined);
  assert.equal(cpos.decodeCpos2, undefined);
  assert.equal(typeof encodePos, "function");
});

test("browser encoder restores source count and fine spectrum", async () => {
  const progress = [];
  const payload = await encodePos(fixturePos(), {
    targetPoints: 4_999,
    onProgress: (stage, fraction) => progress.push([stage, fraction]),
  });
  const header = cpos.inspectCpos(payload);
  const decoded = await cpos.decodeCpos(payload);
  assert.equal(header.originalPointCount, 20_000);
  assert.equal(header.storedPointCount, 4_999);
  assert.equal(decoded.points.length / 4, 20_000);
  assert.equal(
    decoded.fineCounts.reduce((total, count) => total + count, 0),
    20_000,
  );
  assert.equal(header.exactPointCount, 1);
  assert.deepEqual(progress.at(-1), ["CPOS ready", 1]);
});

test("frontend routes POS files through the encoder worker and exposes download", () => {
  const html = readFileSync(
    new URL("../demo/index.html", import.meta.url),
    "utf8",
  );
  const app = readFileSync(
    new URL("../demo/app.js", import.meta.url),
    "utf8",
  );
  assert.match(html, /accept="\.pos,\.POS,\.cpos,\.CPOS"/);
  assert.match(html, /id="download"/);
  assert.match(html, /id="progress"/);
  assert.match(app, /new Worker\(/);
  assert.match(app, /encoder\.worker\.js/);
  assert.match(app, /worker\.postMessage\(\{ buffer, targetPoints/);
  assert.match(app, /if \(\/\\\.pos\$\/i\.test\(file\.name\)\)/);
  assert.match(app, /anchor\.download = downloadName/);
});

test("encoder worker returns a valid transferable CPOS payload", async () => {
  const messages = [];
  globalThis.self = {
    onmessage: null,
    postMessage: (message, transfer) => messages.push({ message, transfer }),
  };
  await import(`../demo/encoder.worker.js?test=${Date.now()}`);
  const source = fixturePos(2_000);
  await self.onmessage({
    data: { buffer: source, targetPoints: 499 },
  });
  const result = messages.find(({ message }) => message.type === "result");
  assert.ok(result);
  assert.equal(result.transfer.length, 1);
  const header = cpos.inspectCpos(result.message.payload);
  assert.equal(header.originalPointCount, 2_000);
  assert.equal(header.storedPointCount, 499);
  delete globalThis.self;
});

test("an earlier beta header layout is rejected", () => {
  const payload = new Uint8Array(cpos.HEADER_SIZE);
  payload.set([0x43, 0x50, 0x4f, 0x53]);
  const view = new DataView(payload.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 128, true);
  assert.throws(
    () => cpos.inspectCpos(payload),
    /unsupported CPOS header/,
  );
});
