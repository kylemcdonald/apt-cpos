import assert from "node:assert/strict";
import test from "node:test";

import * as cpos from "./cpos.js";

test("CPOS beta exposes only the current decoder surface", () => {
  assert.deepEqual(cpos.CONTAINER_VERSION, [1, 0]);
  assert.deepEqual(cpos.ALGORITHM_VERSION, [1, 0, 0]);
  assert.equal(cpos.encodePos, undefined);
  assert.equal(cpos.samplePosBySpectrum, undefined);
  assert.equal(cpos.decodeCpos2, undefined);
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
