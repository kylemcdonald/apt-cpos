/**
 * CPOS beta browser decoder.
 *
 * Rare 0.1 Da bins contain exact 12-bit position/mass tuples. Common bins
 * contain 12-bit spatial seeds plus a 0.002 Da source distribution and are
 * deterministically expanded to the original ion count.
 */

export const CONTAINER_VERSION = Object.freeze([1, 0]);
export const ALGORITHM_VERSION = Object.freeze([1, 0, 0]);
export const HEADER_SIZE = 224;

const MASK12 = 4095;
const BITS = 12;
const UINT32_SCALE = 0x1_0000_0000;
const NOISE_NONE = 0;
const NOISE_UNIFORM = 1;
const NOISE_GAUSSIAN = 2;

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("expected an ArrayBuffer or typed-array view");
}

function viewOf(input) {
  const bytes = bytesOf(input);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function magicAt(bytes, offset, expected) {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function versionString(version) {
  return version.join(".");
}

function number64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("CPOS uint64 exceeds JavaScript's exact integer range");
  }
  return Number(value);
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

export function inspectCpos(input, { verifyChecksum = true } = {}) {
  const bytes = bytesOf(input);
  if (bytes.byteLength < HEADER_SIZE) throw new Error("truncated CPOS header");
  if (!magicAt(bytes, 0, "CPOS")) throw new Error("not a CPOS file");
  const view = viewOf(bytes);
  const containerVersion = [
    view.getUint16(4, true),
    view.getUint16(6, true),
  ];
  const algorithmVersion = [
    view.getUint16(8, true),
    view.getUint16(10, true),
    view.getUint16(12, true),
  ];
  if (
    containerVersion[0] !== CONTAINER_VERSION[0]
    || containerVersion[1] !== CONTAINER_VERSION[1]
  ) {
    throw new Error(`unsupported CPOS container ${versionString(containerVersion)}`);
  }
  if (
    algorithmVersion[0] !== ALGORITHM_VERSION[0]
    || algorithmVersion[1] !== ALGORITHM_VERSION[1]
    || algorithmVersion[2] !== ALGORITHM_VERSION[2]
  ) {
    throw new Error(`unsupported CPOS codec ${versionString(algorithmVersion)}`);
  }

  const headerSize = view.getUint16(14, true);
  const flags = view.getUint32(16, true);
  const originalPointCount = number64(view, 20);
  const storedPointCount = number64(view, 28);
  const targetPointCount = number64(view, 36);
  const exactPointCount = number64(view, 44);
  const spectrumBinCount = view.getUint32(52, true);
  const fineSpectrumBinCount = view.getUint32(56, true);
  const spectrumMinDa = view.getFloat32(60, true);
  const spectrumMaxDa = view.getFloat32(64, true);
  const storedSpectrumBinDa = view.getFloat32(68, true);
  const storedFineSpectrumBinDa = view.getFloat32(72, true);
  const allocationExponent = view.getFloat32(76, true);
  const defaultNoise = view.getUint32(80, true);
  const seed = view.getBigUint64(84, true);
  const minimum = Array.from(
    { length: 3 },
    (_, axis) => view.getFloat32(92 + axis * 4, true),
  );
  const maximum = Array.from(
    { length: 3 },
    (_, axis) => view.getFloat32(104 + axis * 4, true),
  );
  const coreMethod = view.getUint8(116);
  const axisOrder = [view.getUint8(117), view.getUint8(118), view.getUint8(119)];
  const trueCountsOffset = number64(view, 120);
  const storedCountsOffset = number64(view, 128);
  const coreOffset = number64(view, 136);
  const coreCompressedSize = number64(view, 144);
  const coreUncompressedSize = number64(view, 152);
  const fileSize = number64(view, 160);
  const payloadCrc32 = view.getUint32(168, true);
  const reserved = view.getUint32(172, true);

  if (headerSize !== HEADER_SIZE || flags !== 3 || reserved !== 0) {
    throw new Error("unsupported CPOS header");
  }
  for (let offset = 176; offset < HEADER_SIZE; offset += 1) {
    if (bytes[offset] !== 0) throw new Error("unsupported CPOS reserved header data");
  }
  if (
    originalPointCount <= 0
    || storedPointCount <= 0
    || storedPointCount > originalPointCount
    || storedPointCount > targetPointCount
    || exactPointCount > storedPointCount
  ) {
    throw new Error("invalid CPOS point counts");
  }
  const spectrumBinDa = (
    spectrumMaxDa - spectrumMinDa
  ) / spectrumBinCount;
  const fineSpectrumBinDa = (
    spectrumMaxDa - spectrumMinDa
  ) / fineSpectrumBinCount;
  if (
    Math.abs(spectrumMinDa) > 1e-6
    || Math.abs(spectrumMaxDa - 300) > 1e-6
    || Math.abs(spectrumBinDa - storedSpectrumBinDa) > 1e-6
    || Math.abs(fineSpectrumBinDa - storedFineSpectrumBinDa) > 1e-6
    || Math.abs(
      spectrumBinDa / fineSpectrumBinDa
      - Math.round(spectrumBinDa / fineSpectrumBinDa)
    ) > 1e-5
  ) {
    throw new Error("invalid CPOS histogram configuration");
  }
  if (
    !Number.isFinite(allocationExponent)
    || allocationExponent < 0
    || allocationExponent > 1
  ) {
    throw new Error("invalid CPOS allocation exponent");
  }
  if (![NOISE_NONE, NOISE_UNIFORM, NOISE_GAUSSIAN].includes(defaultNoise)) {
    throw new Error("invalid CPOS default noise");
  }
  if (
    minimum.some((value) => !Number.isFinite(value))
    || maximum.some((value) => !Number.isFinite(value))
    || maximum.some((value, axis) => value < minimum[axis])
  ) {
    throw new Error("invalid CPOS spatial bounds");
  }
  if (
    coreMethod !== 2
    || axisOrder[0] !== 0
    || axisOrder[1] !== 1
    || axisOrder[2] !== 2
  ) {
    throw new Error("unsupported CPOS core ordering");
  }
  const expectedStored = HEADER_SIZE + spectrumBinCount * 4;
  const expectedCore = expectedStored + spectrumBinCount * 4;
  const expectedSize = expectedCore + coreCompressedSize;
  if (
    trueCountsOffset !== HEADER_SIZE
    || storedCountsOffset !== expectedStored
    || coreOffset !== expectedCore
    || fileSize !== expectedSize
    || fileSize !== bytes.byteLength
  ) {
    throw new Error("invalid CPOS section layout");
  }
  if (verifyChecksum) {
    const actual = crc32(bytes.subarray(HEADER_SIZE));
    if (actual !== payloadCrc32) {
      throw new Error(
        `CPOS checksum mismatch: expected ${payloadCrc32.toString(16).padStart(8, "0")}, `
        + `got ${actual.toString(16).padStart(8, "0")}`,
      );
    }
  }
  return {
    containerVersion,
    algorithmVersion,
    originalPointCount,
    storedPointCount,
    targetPointCount,
    exactPointCount,
    spectrumBinCount,
    fineSpectrumBinCount,
    spectrumMinDa,
    spectrumMaxDa,
    spectrumBinDa,
    fineSpectrumBinDa,
    allocationExponent,
    defaultNoise,
    seed,
    minimum,
    maximum,
    coreMethod,
    axisOrder,
    trueCountsOffset,
    storedCountsOffset,
    coreOffset,
    coreCompressedSize,
    coreUncompressedSize,
    fileSize,
    payloadCrc32,
  };
}

function readCounts(bytes, offset, count) {
  const view = viewOf(bytes);
  const output = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    output[index] = view.getUint32(offset + index * 4, true);
  }
  return output;
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("this browser does not provide deflate decompression");
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const mortonTables = (() => {
  const tables = [
    new Uint8Array(4096),
    new Uint8Array(4096),
    new Uint8Array(4096),
  ];
  for (let value = 0; value < 4096; value += 1) {
    for (let bit = 0; bit < 4; bit += 1) {
      for (let dimension = 0; dimension < 3; dimension += 1) {
        tables[dimension][value] |= (
          ((value >>> (bit * 3 + dimension)) & 1) << bit
        );
      }
    }
  }
  return tables;
})();

function mortonInverse(key) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let chunk = 0; chunk < 3; chunk += 1) {
    const value = Math.floor(key / (2 ** (chunk * 12))) % 4096;
    const shift = chunk * 4;
    x |= mortonTables[0][value] << shift;
    y |= mortonTables[1][value] << shift;
    z |= mortonTables[2][value] << shift;
  }
  return [x, y, z];
}

function bitplaneValues(bytes, offset, count, width) {
  const output = new Float64Array(count);
  if (width === 0 || count === 0) return output;
  const stride = Math.ceil(count / 8);
  for (let bit = 0; bit < width; bit += 1) {
    const scale = 2 ** bit;
    const planeOffset = offset + bit * stride;
    for (let index = 0; index < count; index += 1) {
      if ((bytes[planeOffset + (index >>> 3)] >>> (index & 7)) & 1) {
        output[index] += scale;
      }
    }
  }
  return output;
}

function decodeCore(core, header, storedCounts) {
  if (!magicAt(core, 0, "H12D")) throw new Error("invalid CPOS hybrid core");
  const view = viewOf(core);
  const count = number64(view, 4);
  const exactCount = number64(view, 12);
  const fineCount = view.getUint32(20, true);
  const activeCount = view.getUint32(24, true);
  const active = [];
  for (let bin = 0; bin < storedCounts.length; bin += 1) {
    if (storedCounts[bin]) active.push(bin);
  }
  if (
    count !== header.storedPointCount
    || exactCount !== header.exactPointCount
    || fineCount !== header.fineSpectrumBinCount
    || activeCount !== active.length
  ) {
    throw new Error("CPOS hybrid core metadata mismatch");
  }

  let offset = 28;
  const fineCounts = new Uint32Array(fineCount);
  for (let index = 0; index < fineCount; index += 1) {
    fineCounts[index] = view.getUint32(offset + index * 4, true);
  }
  offset += fineCount * 4;
  const widths = core.subarray(offset, offset + activeCount);
  offset += activeCount;
  const unaryLengths = new Float64Array(activeCount);
  for (let index = 0; index < activeCount; index += 1) {
    unaryLengths[index] = number64(view, offset + index * 8);
  }
  offset += activeCount * 8;
  let remainderBytes = 0;
  let unaryBytes = 0;
  for (let index = 0; index < activeCount; index += 1) {
    const size = storedCounts[active[index]];
    remainderBytes += Math.ceil(size / 8) * widths[index];
    unaryBytes += Math.ceil(unaryLengths[index] / 8);
  }
  let remainderCursor = offset;
  let unaryCursor = offset + remainderBytes;
  const unaryEnd = unaryCursor + unaryBytes;
  const massSize = Math.ceil(exactCount / 8) * BITS;
  if (unaryEnd + massSize !== core.length) {
    throw new Error("invalid CPOS hybrid core length");
  }

  const positions = new Uint16Array(count * 3);
  let cursor = 0;
  for (let activeIndex = 0; activeIndex < activeCount; activeIndex += 1) {
    const size = storedCounts[active[activeIndex]];
    const width = widths[activeIndex];
    const remainderSize = Math.ceil(size / 8) * width;
    const remainders = bitplaneValues(
      core,
      remainderCursor,
      size,
      width,
    );
    remainderCursor += remainderSize;
    const unaryLength = unaryLengths[activeIndex];
    const unarySize = Math.ceil(unaryLength / 8);
    let previous = -1;
    let local = 0;
    let spatial = 0;
    for (let position = 0; position < unaryLength; position += 1) {
      if ((core[unaryCursor + (position >>> 3)] >>> (position & 7)) & 1) {
        const quotient = position - previous - 1;
        spatial += quotient * (2 ** width) + remainders[local];
        const coordinates = mortonInverse(spatial);
        const record = (cursor + local) * 3;
        positions[record] = coordinates[0];
        positions[record + 1] = coordinates[1];
        positions[record + 2] = coordinates[2];
        previous = position;
        local += 1;
      }
    }
    if (local !== size) throw new Error("invalid CPOS Rice unary stream");
    unaryCursor += unarySize;
    cursor += size;
  }
  const exactMasses = bitplaneValues(core, unaryEnd, exactCount, BITS);
  return { positions, exactMasses, fineCounts };
}

function hashUniform(index, seed, bin, dimension) {
  let value = (
    Math.imul(index, 0x9e3779b1)
    + seed
    + Math.imul(bin, 0x85ebca6b)
    + Math.imul(dimension, 0xc2b2ae35)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / UINT32_SCALE;
}

function positionNoise(index, seed, bin, dimension, mode) {
  if (mode === NOISE_NONE) return 0;
  const uniform = hashUniform(index, seed, bin, dimension);
  if (mode === NOISE_UNIFORM) return uniform - 0.5;
  const companion = hashUniform(
    index,
    (seed ^ 0xa511e9b3) >>> 0,
    bin,
    dimension,
  );
  const gaussian = (
    Math.sqrt(-2 * Math.log(Math.max(uniform, 1e-12)))
    * Math.cos(2 * Math.PI * companion)
    * 0.22
  );
  return Math.max(-0.5, Math.min(0.5, gaussian));
}

function gcd(first, second) {
  let a = first;
  let b = second;
  while (b) [a, b] = [b, a % b];
  return a;
}

function coprimeMultiplier(total, seed, bin) {
  let candidate = (
    (seed ^ Math.imul(bin, 0x9e3779b1)) & ((1 << 20) - 1)
  ) | 1;
  while (gcd(candidate, total) !== 1) {
    candidate = (candidate + 2) & ((1 << 20) - 1);
    if (candidate === 0) candidate = 1;
  }
  return candidate;
}

function findFineBin(cumulative, rank) {
  let low = 0;
  let high = cumulative.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rank < cumulative[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

function noiseMode(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "number" && [0, 1, 2].includes(value)) return value;
  const modes = { none: 0, uniform: 1, gaussian: 2 };
  if (Object.hasOwn(modes, value)) return modes[value];
  throw new Error("noise must be 'none', 'uniform', or 'gaussian'");
}

export async function decodeCpos(input, { noise = null } = {}) {
  const bytes = bytesOf(input);
  const header = inspectCpos(bytes);
  const trueCounts = readCounts(
    bytes,
    header.trueCountsOffset,
    header.spectrumBinCount,
  );
  const storedCounts = readCounts(
    bytes,
    header.storedCountsOffset,
    header.spectrumBinCount,
  );
  let trueTotal = 0;
  let storedTotal = 0;
  let exactTotal = 0;
  for (let bin = 0; bin < trueCounts.length; bin += 1) {
    trueTotal += trueCounts[bin];
    storedTotal += storedCounts[bin];
    if (storedCounts[bin] > trueCounts[bin]) {
      throw new Error("CPOS stored histogram exceeds source histogram");
    }
    if (trueCounts[bin] && trueCounts[bin] === storedCounts[bin]) {
      exactTotal += trueCounts[bin];
    }
  }
  if (
    trueTotal !== header.originalPointCount
    || storedTotal !== header.storedPointCount
    || exactTotal !== header.exactPointCount
  ) {
    throw new Error("CPOS histogram totals do not match the header");
  }

  const compressed = bytes.subarray(
    header.coreOffset,
    header.coreOffset + header.coreCompressedSize,
  );
  const core = await inflate(compressed);
  if (core.length !== header.coreUncompressedSize) {
    throw new Error("CPOS core size mismatch");
  }
  const decoded = decodeCore(core, header, storedCounts);
  let fineTotal = 0;
  for (const count of decoded.fineCounts) fineTotal += count;
  if (fineTotal !== header.originalPointCount) {
    throw new Error("CPOS fine histogram does not match the header");
  }

  const points = new Float32Array(header.originalPointCount * 4);
  const extent = header.maximum.map(
    (maximum, axis) => maximum - header.minimum[axis],
  );
  const finePerCoarse = Math.round(
    header.spectrumBinDa / header.fineSpectrumBinDa,
  );
  const seed32 = Number(header.seed & 0xffffffffn);
  const mode = noiseMode(noise, header.defaultNoise);
  let seedCursor = 0;
  let exactMassCursor = 0;
  let outputCursor = 0;
  for (let bin = 0; bin < trueCounts.length; bin += 1) {
    const total = trueCounts[bin];
    if (!total) continue;
    const stored = storedCounts[bin];
    const exactBin = total === stored;
    for (let local = 0; local < stored; local += 1) {
      const sourceRecord = (seedCursor + local) * 3;
      const outputRecord = (outputCursor + local) * 4;
      for (let dimension = 0; dimension < 3; dimension += 1) {
        points[outputRecord + dimension] = (
          header.minimum[dimension]
          + decoded.positions[sourceRecord + dimension] / MASK12
          * extent[dimension]
        );
      }
    }
    if (exactBin) {
      const lower = header.spectrumMinDa + bin * header.spectrumBinDa;
      const upper = lower + header.spectrumBinDa;
      for (let local = 0; local < total; local += 1) {
        points[(outputCursor + local) * 4 + 3] = Math.min(
          upper - header.spectrumBinDa / (MASK12 * 2),
          lower
          + decoded.exactMasses[exactMassCursor + local] / MASK12
          * header.spectrumBinDa,
        );
      }
      exactMassCursor += total;
    } else {
      const synthesized = total - stored;
      for (let local = 0; local < synthesized; local += 1) {
        const parent = Math.floor((local + 0.5) * stored / synthesized);
        const sourceRecord = (seedCursor + parent) * 3;
        const outputRecord = (outputCursor + stored + local) * 4;
        for (let dimension = 0; dimension < 3; dimension += 1) {
          const quantized = Math.max(
            0,
            Math.min(
              MASK12,
              decoded.positions[sourceRecord + dimension]
              + positionNoise(local, seed32, bin, dimension, mode),
            ),
          );
          points[outputRecord + dimension] = (
            header.minimum[dimension]
            + quantized / MASK12 * extent[dimension]
          );
        }
      }

      const fineStart = bin * finePerCoarse;
      const cumulative = new Float64Array(finePerCoarse);
      let running = 0;
      for (let local = 0; local < finePerCoarse; local += 1) {
        running += decoded.fineCounts[fineStart + local];
        cumulative[local] = running;
      }
      if (running !== total) {
        throw new Error("CPOS fine and coarse histograms disagree");
      }
      const multiplier = coprimeMultiplier(total, seed32, bin);
      const offset = (
        (seed32 ^ Math.imul(bin, 0x85ebca6b)) >>> 0
      ) % total;
      for (let local = 0; local < total; local += 1) {
        const rank = (local * multiplier + offset) % total;
        const fineBin = findFineBin(cumulative, rank);
        const within = 0.1 + 0.8 * hashUniform(
          local,
          (seed32 ^ 0xd1b54a35) >>> 0,
          bin,
          3,
        );
        points[(outputCursor + local) * 4 + 3] = (
          header.spectrumMinDa
          + (fineStart + fineBin + within) * header.fineSpectrumBinDa
        );
      }
    }
    seedCursor += stored;
    outputCursor += total;
  }
  if (
    seedCursor !== header.storedPointCount
    || exactMassCursor !== header.exactPointCount
    || outputCursor !== header.originalPointCount
  ) {
    throw new Error("decoded CPOS point counts do not match");
  }
  return {
    header,
    points,
    trueCounts,
    storedCounts,
    fineCounts: decoded.fineCounts,
  };
}
