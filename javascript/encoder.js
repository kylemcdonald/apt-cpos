/**
 * Browser-side encoder for the current CPOS beta layout.
 *
 * Input is a standard big-endian four-float POS ArrayBuffer. Encoding is
 * asynchronous because the hybrid core is compressed with CompressionStream.
 */

import {
  ALGORITHM_VERSION,
  CONTAINER_VERSION,
  HEADER_SIZE,
} from "./cpos.js";

export const DEFAULT_TARGET_POINTS = 4_000_000;

const BITS = 12;
const MASK12 = (1 << BITS) - 1;
const SPATIAL_BITS = 36;
const SPECTRUM_MIN_DA = 0;
const SPECTRUM_MAX_DA = 300;
const SPECTRUM_BIN_DA = 0.1;
const FINE_SPECTRUM_BIN_DA = 0.002;
const SPECTRUM_BIN_COUNT = 3_000;
const FINE_SPECTRUM_BIN_COUNT = 150_000;
const FINE_PER_COARSE = 50;
const ALLOCATION_EXPONENT = 0.75;
const DEFAULT_NOISE = 1;
const DEFAULT_SEED = 0xc0454dn;
const UINT32_MAX = 0xffff_ffff;

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("expected an ArrayBuffer or typed-array view");
}

function setAscii(bytes, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

let crcTable;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[value] = crc >>> 0;
  }
  return table;
}

function crc32(input) {
  const bytes = bytesOf(input);
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function report(onProgress, stage, fraction) {
  if (typeof onProgress === "function") {
    onProgress(stage, Math.max(0, Math.min(1, fraction)));
  }
}

function massBin(mass, width, count) {
  return Math.max(0, Math.min(count - 1, Math.floor(mass / width)));
}

function quantize(value, minimum, extent) {
  if (extent <= 0) return 0;
  return Math.max(
    0,
    Math.min(MASK12, Math.floor(((value - minimum) / extent) * MASK12 + 0.5)),
  );
}

const mortonSpread = (() => {
  const table = new Float64Array(MASK12 + 1);
  for (let value = 0; value <= MASK12; value += 1) {
    let spread = 0;
    for (let bit = 0; bit < BITS; bit += 1) {
      if ((value >>> bit) & 1) spread += 2 ** (bit * 3);
    }
    table[value] = spread;
  }
  return table;
})();

function quantizedRecord(view, point, minimum, extent, output, offset) {
  const source = point * 16;
  output[offset] = quantize(
    view.getFloat32(source, false),
    minimum[0],
    extent[0],
  );
  output[offset + 1] = quantize(
    view.getFloat32(source + 4, false),
    minimum[1],
    extent[1],
  );
  output[offset + 2] = quantize(
    view.getFloat32(source + 8, false),
    minimum[2],
    extent[2],
  );
}

function mortonForPoint(view, point, minimum, extent) {
  const source = point * 16;
  const x = quantize(
    view.getFloat32(source, false),
    minimum[0],
    extent[0],
  );
  const y = quantize(
    view.getFloat32(source + 4, false),
    minimum[1],
    extent[1],
  );
  const z = quantize(
    view.getFloat32(source + 8, false),
    minimum[2],
    extent[2],
  );
  return mortonSpread[x] + 2 * mortonSpread[y] + 4 * mortonSpread[z];
}

function mortonForQuantized(positions, point) {
  const offset = point * 3;
  return (
    mortonSpread[positions[offset]]
    + 2 * mortonSpread[positions[offset + 1]]
    + 4 * mortonSpread[positions[offset + 2]]
  );
}

function allocateSublinear(counts, limit) {
  let total = 0;
  let activeCount = 0;
  for (const count of counts) {
    total += count;
    if (count) activeCount += 1;
  }
  if (total <= limit) return counts.slice();
  if (limit < activeCount) {
    throw new Error("target is smaller than the number of nonempty mass bins");
  }

  const output = new Uint32Array(counts.length);
  const capacity = new Float64Array(counts.length);
  const weights = new Float64Array(counts.length);
  let remaining = limit - activeCount;
  let upper = 0;
  for (let bin = 0; bin < counts.length; bin += 1) {
    if (!counts[bin]) continue;
    output[bin] = 1;
    capacity[bin] = counts[bin] - 1;
    weights[bin] = counts[bin] ** ALLOCATION_EXPONENT;
    if (capacity[bin]) {
      upper = Math.max(upper, capacity[bin] / weights[bin]);
    }
  }

  let lower = 0;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) * 0.5;
    let allocated = 0;
    for (let bin = 0; bin < counts.length; bin += 1) {
      allocated += Math.min(capacity[bin], midpoint * weights[bin]);
    }
    if (allocated < remaining) lower = midpoint;
    else upper = midpoint;
  }

  const fractional = new Float64Array(counts.length);
  let allocatedTotal = activeCount;
  for (let bin = 0; bin < counts.length; bin += 1) {
    const ideal = Math.min(capacity[bin], upper * weights[bin]);
    const whole = Math.floor(ideal);
    output[bin] += whole;
    fractional[bin] = ideal - whole;
    allocatedTotal += whole;
  }
  remaining = limit - allocatedTotal;
  if (remaining) {
    const candidates = [];
    for (let bin = 0; bin < counts.length; bin += 1) {
      if (output[bin] < counts[bin]) candidates.push(bin);
    }
    candidates.sort((left, right) => (
      fractional[right] - fractional[left]
      || counts[left] - counts[right]
      || left - right
    ));
    for (let index = 0; index < remaining; index += 1) {
      output[candidates[index]] += 1;
    }
  }
  return output;
}

function radixSortMorton(
  view,
  grouped,
  start,
  size,
  minimum,
  extent,
  buffers,
) {
  let fromIndices = grouped.subarray(start, start + size);
  let toIndices = buffers.indices;

  for (let pass = 0; pass < 3; pass += 1) {
    const divisor = 2 ** (pass * 12);
    const counts = buffers.radixCounts;
    const offsets = buffers.radixOffsets;
    counts.fill(0);
    for (let local = 0; local < size; local += 1) {
      const key = mortonForPoint(
        view,
        fromIndices[local],
        minimum,
        extent,
      );
      counts[Math.floor(key / divisor) & MASK12] += 1;
    }
    let cursor = 0;
    for (let digit = 0; digit <= MASK12; digit += 1) {
      offsets[digit] = cursor;
      cursor += counts[digit];
    }
    for (let local = 0; local < size; local += 1) {
      const point = fromIndices[local];
      const key = mortonForPoint(view, point, minimum, extent);
      const digit = Math.floor(key / divisor) & MASK12;
      const destination = offsets[digit]++;
      toIndices[destination] = point;
    }
    [fromIndices, toIndices] = [toIndices, fromIndices];
  }
  return fromIndices;
}

function packBitplanes(values, bits) {
  if (!values.length || !bits) return new Uint8Array();
  const stride = Math.ceil(values.length / 8);
  const output = new Uint8Array(stride * bits);
  for (let bit = 0; bit < bits; bit += 1) {
    const scale = 2 ** bit;
    const plane = bit * stride;
    for (let index = 0; index < values.length; index += 1) {
      if (Math.floor(values[index] / scale) & 1) {
        output[plane + (index >>> 3)] |= 1 << (index & 7);
      }
    }
  }
  return output;
}

function bestRiceWidth(keys, size) {
  let bestWidth = 0;
  let bestBits = Infinity;
  let bestQuotientTotal = 0;
  for (let width = 0; width <= SPATIAL_BITS; width += 1) {
    const divisor = 2 ** width;
    let previous = 0;
    let quotientTotal = 0;
    for (let index = 0; index < size; index += 1) {
      const key = keys[index];
      quotientTotal += Math.floor((key - previous) / divisor);
      previous = key;
    }
    const bits = size * (width + 1) + quotientTotal;
    if (bits < bestBits) {
      bestBits = bits;
      bestWidth = width;
      bestQuotientTotal = quotientTotal;
    } else {
      break;
    }
  }
  return { width: bestWidth, quotientTotal: bestQuotientTotal };
}

function encodeSpatialGroup(keys, size) {
  const { width, quotientTotal } = bestRiceWidth(keys, size);
  const stride = Math.ceil(size / 8);
  const remainder = new Uint8Array(stride * width);
  for (let bit = 0; bit < width; bit += 1) {
    const scale = 2 ** bit;
    const plane = bit * stride;
    let previous = 0;
    for (let index = 0; index < size; index += 1) {
      const key = keys[index];
      const gap = key - previous;
      if (Math.floor(gap / scale) & 1) {
        remainder[plane + (index >>> 3)] |= 1 << (index & 7);
      }
      previous = key;
    }
  }

  const unaryLength = quotientTotal + size;
  const unary = new Uint8Array(Math.ceil(unaryLength / 8));
  const divisor = 2 ** width;
  let previous = 0;
  let unaryPosition = 0;
  for (let index = 0; index < size; index += 1) {
    const key = keys[index];
    unaryPosition += Math.floor((key - previous) / divisor);
    unary[unaryPosition >>> 3] |= 1 << (unaryPosition & 7);
    unaryPosition += 1;
    previous = key;
  }
  return { width, unaryLength, remainder, unary };
}

function createCore(positions, storedCounts, exactMasses, fineCounts, onProgress) {
  let activeCount = 0;
  let maximumGroup = 0;
  for (const count of storedCounts) {
    if (count) {
      activeCount += 1;
      maximumGroup = Math.max(maximumGroup, count);
    }
  }
  const widths = new Uint8Array(activeCount);
  const unaryLengths = new Float64Array(activeCount);
  const remainderStreams = new Array(activeCount);
  const unaryStreams = new Array(activeCount);
  const keys = new Float64Array(maximumGroup);

  let pointCursor = 0;
  let activeIndex = 0;
  for (let bin = 0; bin < storedCounts.length; bin += 1) {
    const size = storedCounts[bin];
    if (!size) continue;
    let previous = -1;
    for (let local = 0; local < size; local += 1) {
      const key = mortonForQuantized(positions, pointCursor + local);
      if (key < previous) throw new Error("grouped spatial keys are not sorted");
      keys[local] = key;
      previous = key;
    }
    const encoded = encodeSpatialGroup(keys, size);
    widths[activeIndex] = encoded.width;
    unaryLengths[activeIndex] = encoded.unaryLength;
    remainderStreams[activeIndex] = encoded.remainder;
    unaryStreams[activeIndex] = encoded.unary;
    pointCursor += size;
    activeIndex += 1;
    if ((activeIndex & 31) === 0 || activeIndex === activeCount) {
      report(
        onProgress,
        `packing spatial groups · ${activeIndex.toLocaleString("en-US")}/${activeCount.toLocaleString("en-US")}`,
        0.58 + 0.18 * activeIndex / activeCount,
      );
    }
  }

  const exactMassBytes = packBitplanes(exactMasses, BITS);
  const remainderSize = remainderStreams.reduce(
    (total, stream) => total + stream.length,
    0,
  );
  const unarySize = unaryStreams.reduce(
    (total, stream) => total + stream.length,
    0,
  );
  const coreSize = (
    28
    + fineCounts.byteLength
    + widths.byteLength
    + unaryLengths.byteLength
    + remainderSize
    + unarySize
    + exactMassBytes.byteLength
  );
  const core = new Uint8Array(coreSize);
  const view = new DataView(core.buffer);
  setAscii(core, 0, "H12D");
  view.setBigUint64(4, BigInt(positions.length / 3), true);
  view.setBigUint64(12, BigInt(exactMasses.length), true);
  view.setUint32(20, fineCounts.length, true);
  view.setUint32(24, activeCount, true);
  let offset = 28;
  for (let index = 0; index < fineCounts.length; index += 1) {
    view.setUint32(offset + index * 4, fineCounts[index], true);
  }
  offset += fineCounts.byteLength;
  core.set(widths, offset);
  offset += widths.byteLength;
  for (let index = 0; index < unaryLengths.length; index += 1) {
    view.setBigUint64(offset + index * 8, BigInt(unaryLengths[index]), true);
  }
  offset += unaryLengths.byteLength;
  for (const stream of remainderStreams) {
    core.set(stream, offset);
    offset += stream.length;
  }
  for (const stream of unaryStreams) {
    core.set(stream, offset);
    offset += stream.length;
  }
  core.set(exactMassBytes, offset);
  return core;
}

async function deflate(input) {
  if (typeof CompressionStream !== "function") {
    throw new Error("this browser does not provide deflate compression");
  }
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePos(
  input,
  {
    targetPoints = DEFAULT_TARGET_POINTS,
    onProgress = null,
  } = {},
) {
  const bytes = bytesOf(input);
  if (!bytes.byteLength || bytes.byteLength % 16 !== 0) {
    throw new Error("POS file size must be a nonzero multiple of 16 bytes");
  }
  const pointCount = bytes.byteLength / 16;
  if (pointCount > UINT32_MAX) {
    throw new Error("CPOS supports at most 2^32 - 1 source points");
  }
  if (
    !Number.isSafeInteger(targetPoints)
    || targetPoints <= 0
  ) {
    throw new Error("targetPoints must be a positive safe integer");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trueCounts = new Uint32Array(SPECTRUM_BIN_COUNT);
  const fineCounts = new Uint32Array(FINE_SPECTRUM_BIN_COUNT);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  report(onProgress, "reading POS records", 0.01);
  for (let point = 0; point < pointCount; point += 1) {
    const offset = point * 16;
    for (let dimension = 0; dimension < 3; dimension += 1) {
      const value = view.getFloat32(offset + dimension * 4, false);
      if (!Number.isFinite(value)) throw new Error("POS contains non-finite values");
      minimum[dimension] = Math.min(minimum[dimension], value);
      maximum[dimension] = Math.max(maximum[dimension], value);
    }
    const mass = view.getFloat32(offset + 12, false);
    if (!Number.isFinite(mass)) throw new Error("POS contains non-finite values");
    trueCounts[massBin(mass, SPECTRUM_BIN_DA, SPECTRUM_BIN_COUNT)] += 1;
    fineCounts[
      massBin(mass, FINE_SPECTRUM_BIN_DA, FINE_SPECTRUM_BIN_COUNT)
    ] += 1;
    if ((point & 0x7ffff) === 0) {
      report(
        onProgress,
        `reading POS records · ${Math.round(100 * point / pointCount)}%`,
        0.01 + 0.11 * point / pointCount,
      );
    }
  }

  const storedPointCount = Math.min(pointCount, targetPoints);
  const storedCounts = allocateSublinear(trueCounts, storedPointCount);
  let exactPointCount = 0;
  let maximumBin = 0;
  for (let bin = 0; bin < trueCounts.length; bin += 1) {
    maximumBin = Math.max(maximumBin, trueCounts[bin]);
    if (trueCounts[bin] && trueCounts[bin] === storedCounts[bin]) {
      exactPointCount += trueCounts[bin];
    }
  }
  report(onProgress, "grouping mass bins", 0.13);

  const starts = new Uint32Array(SPECTRUM_BIN_COUNT + 1);
  for (let bin = 0; bin < SPECTRUM_BIN_COUNT; bin += 1) {
    starts[bin + 1] = starts[bin] + trueCounts[bin];
  }
  const cursors = starts.slice(0, SPECTRUM_BIN_COUNT);
  const grouped = new Uint32Array(pointCount);
  for (let point = 0; point < pointCount; point += 1) {
    const mass = view.getFloat32(point * 16 + 12, false);
    const bin = massBin(mass, SPECTRUM_BIN_DA, SPECTRUM_BIN_COUNT);
    grouped[cursors[bin]] = point;
    cursors[bin] += 1;
    if ((point & 0x7ffff) === 0) {
      report(
        onProgress,
        `grouping mass bins · ${Math.round(100 * point / pointCount)}%`,
        0.13 + 0.09 * point / pointCount,
      );
    }
  }

  const extent = maximum.map((value, dimension) => value - minimum[dimension]);
  const positions = new Uint16Array(storedPointCount * 3);
  const exactMasses = new Uint16Array(exactPointCount);
  const buffers = {
    indices: new Uint32Array(maximumBin),
    radixCounts: new Uint32Array(MASK12 + 1),
    radixOffsets: new Uint32Array(MASK12 + 1),
  };
  let selectedCursor = 0;
  let exactCursor = 0;
  let completedSourcePoints = 0;
  for (let bin = 0; bin < trueCounts.length; bin += 1) {
    const count = trueCounts[bin];
    const take = storedCounts[bin];
    if (!take) continue;
    const sorted = radixSortMorton(
      view,
      grouped,
      starts[bin],
      count,
      minimum,
      extent,
      buffers,
    );
    const exactBin = count === take;
    for (let local = 0; local < take; local += 1) {
      const rank = Math.floor((local + 0.5) * count / take);
      const point = sorted[rank];
      quantizedRecord(
        view,
        point,
        minimum,
        extent,
        positions,
        selectedCursor * 3,
      );
      selectedCursor += 1;
      if (exactBin) {
        const mass = view.getFloat32(point * 16 + 12, false);
        const localMass = (
          mass - (SPECTRUM_MIN_DA + bin * SPECTRUM_BIN_DA)
        ) / SPECTRUM_BIN_DA;
        exactMasses[exactCursor] = Math.max(
          0,
          Math.min(MASK12, Math.floor(localMass * MASK12 + 0.5)),
        );
        exactCursor += 1;
      }
    }
    completedSourcePoints += count;
    report(
      onProgress,
      `selecting spatial seeds · ${Math.round(100 * completedSourcePoints / pointCount)}%`,
      0.22 + 0.34 * completedSourcePoints / pointCount,
    );
  }
  if (
    selectedCursor !== storedPointCount
    || exactCursor !== exactPointCount
  ) {
    throw new Error("CPOS seed selection count mismatch");
  }

  report(onProgress, "packing hybrid core", 0.57);
  const core = createCore(
    positions,
    storedCounts,
    exactMasses,
    fineCounts,
    onProgress,
  );
  report(onProgress, "compressing hybrid core", 0.78);
  const compressed = await deflate(core);

  const trueCountsOffset = HEADER_SIZE;
  const storedCountsOffset = trueCountsOffset + trueCounts.byteLength;
  const coreOffset = storedCountsOffset + storedCounts.byteLength;
  const fileSize = coreOffset + compressed.byteLength;
  const output = new Uint8Array(fileSize);
  const outputView = new DataView(output.buffer);
  setAscii(output, 0, "CPOS");
  outputView.setUint16(4, CONTAINER_VERSION[0], true);
  outputView.setUint16(6, CONTAINER_VERSION[1], true);
  outputView.setUint16(8, ALGORITHM_VERSION[0], true);
  outputView.setUint16(10, ALGORITHM_VERSION[1], true);
  outputView.setUint16(12, ALGORITHM_VERSION[2], true);
  outputView.setUint16(14, HEADER_SIZE, true);
  outputView.setUint32(16, 3, true);
  outputView.setBigUint64(20, BigInt(pointCount), true);
  outputView.setBigUint64(28, BigInt(storedPointCount), true);
  outputView.setBigUint64(36, BigInt(targetPoints), true);
  outputView.setBigUint64(44, BigInt(exactPointCount), true);
  outputView.setUint32(52, SPECTRUM_BIN_COUNT, true);
  outputView.setUint32(56, FINE_SPECTRUM_BIN_COUNT, true);
  outputView.setFloat32(60, SPECTRUM_MIN_DA, true);
  outputView.setFloat32(64, SPECTRUM_MAX_DA, true);
  outputView.setFloat32(68, SPECTRUM_BIN_DA, true);
  outputView.setFloat32(72, FINE_SPECTRUM_BIN_DA, true);
  outputView.setFloat32(76, ALLOCATION_EXPONENT, true);
  outputView.setUint32(80, DEFAULT_NOISE, true);
  outputView.setBigUint64(84, DEFAULT_SEED, true);
  for (let dimension = 0; dimension < 3; dimension += 1) {
    outputView.setFloat32(92 + dimension * 4, minimum[dimension], true);
    outputView.setFloat32(104 + dimension * 4, maximum[dimension], true);
  }
  outputView.setUint8(116, 2);
  outputView.setUint8(117, 0);
  outputView.setUint8(118, 1);
  outputView.setUint8(119, 2);
  outputView.setBigUint64(120, BigInt(trueCountsOffset), true);
  outputView.setBigUint64(128, BigInt(storedCountsOffset), true);
  outputView.setBigUint64(136, BigInt(coreOffset), true);
  outputView.setBigUint64(144, BigInt(compressed.byteLength), true);
  outputView.setBigUint64(152, BigInt(core.byteLength), true);
  outputView.setBigUint64(160, BigInt(fileSize), true);
  for (let index = 0; index < trueCounts.length; index += 1) {
    outputView.setUint32(trueCountsOffset + index * 4, trueCounts[index], true);
    outputView.setUint32(storedCountsOffset + index * 4, storedCounts[index], true);
  }
  output.set(compressed, coreOffset);
  outputView.setUint32(168, crc32(output.subarray(HEADER_SIZE)), true);
  report(onProgress, "CPOS ready", 1);
  return output;
}
