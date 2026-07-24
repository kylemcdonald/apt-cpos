"""CPOS beta hybrid codec.

Rare mass bins are retained as exact 12-bit tuples.  Common mass bins retain
12-bit spatial seeds and an exact fine mass histogram, then expand
deterministically to the source ion count.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import asdict, dataclass

import numpy as np

MAGIC = b"CPOS"
CONTAINER_VERSION = (1, 0)
ALGORITHM_VERSION = (1, 0, 0)
HEADER_SIZE = 224
FLAGS = 0x03
BITS = 12
LEVELS = 1 << BITS
MASK12 = LEVELS - 1
SPATIAL_BITS = 36
DEFAULT_TARGET_POINTS = 4_000_000
DEFAULT_BIN_WIDTH_DA = 0.1
DEFAULT_FINE_BIN_WIDTH_DA = 0.002
DEFAULT_ALLOCATION_EXPONENT = 0.75
SPECTRUM_MIN_DA = 0.0
SPECTRUM_MAX_DA = 300.0
CORE_HYBRID_MORTON_RICE = 2
AXIS_ORDER = (0, 1, 2)
NOISE_NONE = 0
NOISE_UNIFORM = 1
NOISE_GAUSSIAN = 2
DEFAULT_NOISE = NOISE_UNIFORM
DEFAULT_SEED = 0xC0454D
UINT32_MAX = (1 << 32) - 1

# magic; versions/header; flags; source/seed/target/exact counts; coarse/fine
# spectrum sizes; spectrum/allocation fields; noise and seed; spatial bounds;
# core/axis order; section layout; checksum and reserved.
_HEADER = struct.Struct("<4s6HI4Q2I5fIQ6f4B6Q2I")
assert _HEADER.size == 176


class CposVersionError(ValueError):
    """Raised when a CPOS file requires an unsupported format version."""


@dataclass(frozen=True)
class CposHeader:
    container_version: tuple[int, int]
    algorithm_version: tuple[int, int, int]
    header_size: int
    flags: int
    original_point_count: int
    stored_point_count: int
    target_point_count: int
    exact_point_count: int
    spectrum_bin_count: int
    fine_spectrum_bin_count: int
    spectrum_min_da: float
    spectrum_max_da: float
    spectrum_bin_da: float
    fine_spectrum_bin_da: float
    allocation_exponent: float
    default_noise: int
    seed: int
    minimum: tuple[float, float, float]
    maximum: tuple[float, float, float]
    core_method: int
    axis_order: tuple[int, int, int]
    true_counts_offset: int
    stored_counts_offset: int
    core_offset: int
    core_compressed_size: int
    core_uncompressed_size: int
    file_size: int
    payload_crc32: int

    @property
    def bounds(
        self,
    ) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        return self.minimum, self.maximum

    def to_dict(self) -> dict:
        output = asdict(self)
        output["container_version"] = ".".join(map(str, self.container_version))
        output["algorithm_version"] = ".".join(map(str, self.algorithm_version))
        output["payload_crc32"] = f"{self.payload_crc32:08x}"
        output["bounds"] = [list(self.minimum), list(self.maximum)]
        return output


@dataclass(frozen=True)
class RetainedCloud:
    header: CposHeader
    quantized_positions: np.ndarray
    exact_quantized_masses: np.ndarray
    bins: np.ndarray
    true_counts: np.ndarray
    stored_counts: np.ndarray
    fine_counts: np.ndarray


@dataclass(frozen=True)
class DecodedCloud:
    header: CposHeader
    points: np.ndarray
    exact: np.ndarray
    bins: np.ndarray
    true_counts: np.ndarray
    stored_counts: np.ndarray
    fine_counts: np.ndarray


def _point_array(points: np.ndarray) -> np.ndarray:
    array = np.asarray(points, dtype=np.float32)
    if array.ndim != 2 or array.shape[1] != 4 or len(array) == 0:
        raise ValueError("points must have shape (N, 4) with N > 0")
    if len(array) > UINT32_MAX:
        raise ValueError("CPOS supports at most 2^32 - 1 source points")
    if not np.isfinite(array).all():
        raise ValueError("points contain non-finite values")
    return array


def _bin_count(bin_width: float) -> int:
    if not np.isfinite(bin_width) or bin_width <= 0:
        raise ValueError("spectrum bin widths must be positive and finite")
    count = int(round((SPECTRUM_MAX_DA - SPECTRUM_MIN_DA) / bin_width))
    if (
        count <= 0
        or count > UINT32_MAX
        or not np.isclose(
            count * bin_width,
            SPECTRUM_MAX_DA - SPECTRUM_MIN_DA,
            rtol=0,
            atol=1e-4,
        )
    ):
        raise ValueError("spectrum bin widths must divide the 0–300 Da range")
    return count


def _mass_bins(mass: np.ndarray, width: float, count: int) -> np.ndarray:
    bins = np.floor(
        (
            np.asarray(mass, dtype=np.float32).astype(np.float64)
            - SPECTRUM_MIN_DA
        )
        / width,
    ).astype(np.int64)
    return np.clip(bins, 0, count - 1).astype(np.int32)


def allocate_sublinear(
    counts: np.ndarray,
    limit: int,
    exponent: float,
) -> np.ndarray:
    """Allocate capped ``count ** exponent`` quotas deterministically."""
    source = np.asarray(counts, dtype=np.int64)
    if source.ndim != 1 or np.any(source < 0):
        raise ValueError("counts must be a one-dimensional nonnegative array")
    total = int(source.sum(dtype=np.int64))
    if limit <= 0:
        raise ValueError("limit must be positive")
    if not np.isfinite(exponent) or not 0 <= exponent <= 1:
        raise ValueError("allocation exponent must be in [0, 1]")
    if total <= limit:
        return source.copy()

    active = source > 0
    active_count = int(active.sum())
    if limit < active_count:
        raise ValueError(
            "target is smaller than the number of nonempty mass bins",
        )
    output = active.astype(np.int64)
    remaining = limit - active_count
    if not remaining:
        return output

    capacity = source - output
    weights = np.zeros(len(source), dtype=np.float64)
    weights[active] = np.power(source[active].astype(np.float64), exponent)
    can_grow = capacity > 0
    lower = 0.0
    upper = float(np.max(capacity[can_grow] / weights[can_grow]))
    for _ in range(80):
        midpoint = (lower + upper) * 0.5
        allocated = np.minimum(
            capacity.astype(np.float64),
            midpoint * weights,
        ).sum()
        if allocated < remaining:
            lower = midpoint
        else:
            upper = midpoint

    ideal = np.minimum(capacity.astype(np.float64), upper * weights)
    output += np.floor(ideal).astype(np.int64)
    leftover = limit - int(output.sum(dtype=np.int64))
    if leftover:
        candidates = np.flatnonzero(output < source)
        fractional = ideal[candidates] - np.floor(ideal[candidates])
        order = np.lexsort((candidates, source[candidates], -fractional))
        output[candidates[order[:leftover]]] += 1
    if int(output.sum(dtype=np.int64)) != limit or np.any(output > source):
        raise AssertionError("invalid sublinear allocation")
    return output


def _spread_table() -> np.ndarray:
    table = np.zeros(LEVELS, dtype=np.uint64)
    for value in range(LEVELS):
        spread = 0
        for bit in range(BITS):
            spread |= ((value >> bit) & 1) << (bit * 3)
        table[value] = spread
    return table


_MORTON3 = _spread_table()


def _spatial_morton(values: np.ndarray) -> np.ndarray:
    return (
        _MORTON3[values[:, 0]]
        | (_MORTON3[values[:, 1]] << np.uint64(1))
        | (_MORTON3[values[:, 2]] << np.uint64(2))
    )


def _spatial_morton_inverse(keys: np.ndarray) -> np.ndarray:
    source = np.asarray(keys, dtype=np.uint64)
    output = np.zeros((len(source), 3), dtype=np.uint16)
    for bit in range(BITS):
        for dimension in range(3):
            output[:, dimension] |= (
                (
                    source >> np.uint64(bit * 3 + dimension)
                )
                & np.uint64(1)
            ).astype(np.uint16) << np.uint16(bit)
    return output


def _pack_bitplanes(values: np.ndarray, bits: int) -> bytes:
    source = np.asarray(values)
    if bits == 0 or not len(source):
        return b""
    planes = np.empty((bits, (len(source) + 7) // 8), dtype=np.uint8)
    for bit in range(bits):
        planes[bit] = np.packbits(
            ((source >> bit) & 1).astype(np.uint8),
            bitorder="little",
        )
    return planes.tobytes()


def _unpack_bitplanes(data: bytes, count: int, bits: int) -> np.ndarray:
    output = np.zeros(count, dtype=np.uint64)
    if bits == 0 or count == 0:
        return output
    stride = (count + 7) // 8
    if len(data) != stride * bits:
        raise ValueError("invalid CPOS bitplane stream length")
    source = np.frombuffer(data, dtype=np.uint8).reshape(bits, stride)
    for bit in range(bits):
        plane = np.unpackbits(source[bit], bitorder="little")[:count]
        output |= plane.astype(np.uint64) << np.uint64(bit)
    return output


def _best_rice_parameter(gaps: np.ndarray) -> int:
    source = np.asarray(gaps, dtype=np.uint64)
    best_width = 0
    best_bits: int | None = None
    for width in range(SPATIAL_BITS + 1):
        bits = len(source) * (width + 1) + int(
            np.sum(source >> np.uint64(width), dtype=np.uint64),
        )
        if best_bits is None or bits < best_bits:
            best_bits = bits
            best_width = width
    return best_width


def _quantize_positions(
    points: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    minimum = points[:, :3].min(axis=0).astype(np.float32)
    maximum = points[:, :3].max(axis=0).astype(np.float32)
    extent = maximum.astype(np.float64) - minimum.astype(np.float64)
    safe_extent = np.where(extent > 0, extent, 1.0)
    normalized = (
        points[:, :3].astype(np.float64) - minimum.astype(np.float64)
    ) / safe_extent
    values = np.clip(
        np.floor(normalized * MASK12 + 0.5),
        0,
        MASK12,
    ).astype(np.uint16)
    return values, minimum, maximum


def _select_indices(
    positions: np.ndarray,
    bins: np.ndarray,
    counts: np.ndarray,
    allocation: np.ndarray,
) -> np.ndarray:
    combined = (
        bins.astype(np.uint64) << np.uint64(SPATIAL_BITS)
    ) | _spatial_morton(positions)
    order = np.argsort(combined, kind="stable")
    starts = np.empty(len(counts) + 1, dtype=np.int64)
    starts[0] = 0
    np.cumsum(counts, dtype=np.int64, out=starts[1:])
    selected = np.empty(int(allocation.sum(dtype=np.int64)), dtype=np.int64)
    cursor = 0
    for bin_index in np.flatnonzero(allocation):
        take = int(allocation[bin_index])
        count = int(counts[bin_index])
        ranks = np.floor(
            (np.arange(take, dtype=np.float64) + 0.5) * count / take,
        ).astype(np.int64)
        selected[cursor:cursor + take] = order[starts[bin_index] + ranks]
        cursor += take
    return selected


def _group_slices(counts: np.ndarray):
    cursor = 0
    for bin_index, count in enumerate(counts):
        size = int(count)
        if size:
            yield bin_index, cursor, cursor + size
            cursor += size


def _quantize_exact_masses(
    points: np.ndarray,
    selected: np.ndarray,
    true_counts: np.ndarray,
    stored_counts: np.ndarray,
    bin_width: float,
) -> np.ndarray:
    exact_count = int(true_counts[true_counts == stored_counts].sum())
    output = np.empty(exact_count, dtype=np.uint16)
    selected_cursor = 0
    exact_cursor = 0
    for bin_index, count in enumerate(stored_counts):
        size = int(count)
        if not size:
            continue
        if count == true_counts[bin_index]:
            mass = points[selected[selected_cursor:selected_cursor + size], 3]
            local = (
                mass.astype(np.float64)
                - (SPECTRUM_MIN_DA + bin_index * bin_width)
            ) / bin_width
            output[exact_cursor:exact_cursor + size] = np.clip(
                np.floor(local * MASK12 + 0.5),
                0,
                MASK12,
            ).astype(np.uint16)
            exact_cursor += size
        selected_cursor += size
    if exact_cursor != exact_count:
        raise AssertionError("exact mass count mismatch")
    return output


def _encode_core(
    positions: np.ndarray,
    stored_counts: np.ndarray,
    exact_masses: np.ndarray,
    fine_counts: np.ndarray,
) -> bytes:
    active = np.flatnonzero(stored_counts)
    widths = np.empty(len(active), dtype=np.uint8)
    unary_lengths = np.empty(len(active), dtype="<u8")
    remainder_streams: list[bytes] = []
    unary_streams: list[bytes] = []
    spatial_all = _spatial_morton(positions)
    for active_index, (_, start, end) in enumerate(_group_slices(stored_counts)):
        spatial = spatial_all[start:end]
        if np.any(spatial[1:] < spatial[:-1]):
            raise AssertionError("grouped spatial keys are not sorted")
        gaps = np.empty_like(spatial)
        gaps[0] = spatial[0]
        gaps[1:] = spatial[1:] - spatial[:-1]
        width = _best_rice_parameter(gaps)
        widths[active_index] = width
        remainder = gaps & np.uint64((1 << width) - 1 if width else 0)
        remainder_streams.append(_pack_bitplanes(remainder, width))
        quotient = gaps >> np.uint64(width)
        ends = np.cumsum(quotient + np.uint64(1), dtype=np.uint64) - 1
        unary_lengths[active_index] = int(ends[-1]) + 1
        unary = np.zeros(int(unary_lengths[active_index]), dtype=np.uint8)
        unary[ends.astype(np.int64)] = 1
        unary_streams.append(np.packbits(unary, bitorder="little").tobytes())
    return (
        b"H12D"
        + struct.pack(
            "<QQII",
            len(positions),
            len(exact_masses),
            len(fine_counts),
            len(active),
        )
        + fine_counts.astype("<u4", copy=False).tobytes()
        + widths.tobytes()
        + unary_lengths.tobytes()
        + b"".join(remainder_streams)
        + b"".join(unary_streams)
        + _pack_bitplanes(exact_masses, BITS)
    )


def encode(
    points: np.ndarray,
    *,
    target_points: int = DEFAULT_TARGET_POINTS,
    bin_width_da: float = DEFAULT_BIN_WIDTH_DA,
    fine_bin_width_da: float = DEFAULT_FINE_BIN_WIDTH_DA,
    allocation_exponent: float = DEFAULT_ALLOCATION_EXPONENT,
    seed: int = DEFAULT_SEED,
) -> bytes:
    """Encode an ion cloud as rare tuples plus common-ion distributions."""
    array = _point_array(points)
    if not isinstance(target_points, (int, np.integer)) or target_points <= 0:
        raise ValueError("target_points must be a positive integer")
    if not isinstance(seed, (int, np.integer)) or not 0 <= seed < (1 << 64):
        raise ValueError("seed must be an unsigned 64-bit integer")
    if not np.isfinite(allocation_exponent) or not 0 <= allocation_exponent <= 1:
        raise ValueError("allocation exponent must be in [0, 1]")

    bin_count = _bin_count(bin_width_da)
    fine_bin_count = _bin_count(fine_bin_width_da)
    ratio = bin_width_da / fine_bin_width_da
    if not np.isclose(ratio, round(ratio), rtol=0, atol=1e-8):
        raise ValueError("fine_bin_width_da must divide bin_width_da")

    bins = _mass_bins(array[:, 3], bin_width_da, bin_count)
    fine_bins = _mass_bins(array[:, 3], fine_bin_width_da, fine_bin_count)
    true_counts = np.bincount(bins, minlength=bin_count).astype(np.int64)
    fine_counts = np.bincount(
        fine_bins,
        minlength=fine_bin_count,
    ).astype(np.int64)
    stored_count = min(len(array), int(target_points))
    stored_counts = allocate_sublinear(
        true_counts,
        stored_count,
        allocation_exponent,
    )
    exact_bins = (true_counts > 0) & (true_counts == stored_counts)
    exact_count = int(true_counts[exact_bins].sum(dtype=np.int64))

    positions, minimum, maximum = _quantize_positions(array)
    selected = _select_indices(positions, bins, true_counts, stored_counts)
    selected_positions = positions[selected]
    exact_masses = _quantize_exact_masses(
        array,
        selected,
        true_counts,
        stored_counts,
        bin_width_da,
    )
    core = _encode_core(
        selected_positions,
        stored_counts,
        exact_masses,
        fine_counts,
    )
    compressed_core = zlib.compress(core, level=9)

    true_counts_offset = HEADER_SIZE
    stored_counts_offset = true_counts_offset + bin_count * 4
    core_offset = stored_counts_offset + bin_count * 4
    file_size = core_offset + len(compressed_core)
    true_bytes = true_counts.astype("<u4").tobytes()
    stored_bytes = stored_counts.astype("<u4").tobytes()
    payload = true_bytes + stored_bytes + compressed_core
    payload_crc32 = zlib.crc32(payload) & UINT32_MAX
    header = bytearray(HEADER_SIZE)
    _HEADER.pack_into(
        header,
        0,
        MAGIC,
        *CONTAINER_VERSION,
        *ALGORITHM_VERSION,
        HEADER_SIZE,
        FLAGS,
        len(array),
        stored_count,
        int(target_points),
        exact_count,
        bin_count,
        fine_bin_count,
        SPECTRUM_MIN_DA,
        SPECTRUM_MAX_DA,
        float(bin_width_da),
        float(fine_bin_width_da),
        float(allocation_exponent),
        DEFAULT_NOISE,
        int(seed),
        *minimum,
        *maximum,
        CORE_HYBRID_MORTON_RICE,
        *AXIS_ORDER,
        true_counts_offset,
        stored_counts_offset,
        core_offset,
        len(compressed_core),
        len(core),
        file_size,
        payload_crc32,
        0,
    )
    return bytes(header) + payload


def inspect(
    data: bytes | bytearray | memoryview,
    verify_checksum: bool = True,
) -> CposHeader:
    """Parse and validate a CPOS beta header."""
    view = memoryview(data).cast("B")
    if len(view) < HEADER_SIZE:
        raise ValueError("truncated CPOS header")
    values = _HEADER.unpack_from(view, 0)
    (
        magic,
        container_major,
        container_minor,
        algorithm_major,
        algorithm_minor,
        algorithm_patch,
        header_size,
        flags,
        original_count,
        stored_count,
        target_count,
        exact_count,
        spectrum_bins,
        fine_spectrum_bins,
        spectrum_min,
        spectrum_max,
        spectrum_bin,
        fine_spectrum_bin,
        allocation_exponent,
        default_noise,
        seed,
        xmin,
        ymin,
        zmin,
        xmax,
        ymax,
        zmax,
        core_method,
        axis_x,
        axis_y,
        axis_z,
        true_counts_offset,
        stored_counts_offset,
        core_offset,
        core_compressed_size,
        core_uncompressed_size,
        file_size,
        payload_crc32,
        reserved,
    ) = values
    if magic != MAGIC:
        raise ValueError("not a CPOS file")
    if (container_major, container_minor) != CONTAINER_VERSION:
        raise CposVersionError(
            f"unsupported CPOS container {container_major}.{container_minor}",
        )
    if (algorithm_major, algorithm_minor, algorithm_patch) != ALGORITHM_VERSION:
        raise CposVersionError(
            "unsupported CPOS codec "
            f"{algorithm_major}.{algorithm_minor}.{algorithm_patch}",
        )
    if (
        header_size != HEADER_SIZE
        or flags != FLAGS
        or reserved != 0
        or any(view[_HEADER.size:HEADER_SIZE])
    ):
        raise ValueError("unsupported CPOS header")
    if (
        original_count <= 0
        or stored_count <= 0
        or stored_count > original_count
        or stored_count > target_count
        or exact_count > stored_count
    ):
        raise ValueError("invalid CPOS point counts")
    if (
        not np.isclose(spectrum_min, SPECTRUM_MIN_DA, rtol=0, atol=1e-6)
        or not np.isclose(spectrum_max, SPECTRUM_MAX_DA, rtol=0, atol=1e-6)
        or spectrum_bins != _bin_count(spectrum_bin)
        or fine_spectrum_bins != _bin_count(fine_spectrum_bin)
        or not np.isclose(
            spectrum_bin / fine_spectrum_bin,
            round(spectrum_bin / fine_spectrum_bin),
            rtol=0,
            atol=1e-5,
        )
    ):
        raise ValueError("invalid CPOS histogram configuration")
    if not np.isfinite(allocation_exponent) or not 0 <= allocation_exponent <= 1:
        raise ValueError("invalid CPOS allocation exponent")
    if default_noise not in (NOISE_NONE, NOISE_UNIFORM, NOISE_GAUSSIAN):
        raise ValueError("invalid CPOS default noise")
    if (
        not np.isfinite((xmin, ymin, zmin, xmax, ymax, zmax)).all()
        or xmax < xmin
        or ymax < ymin
        or zmax < zmin
    ):
        raise ValueError("invalid CPOS spatial bounds")
    if (
        core_method != CORE_HYBRID_MORTON_RICE
        or (axis_x, axis_y, axis_z) != AXIS_ORDER
    ):
        raise ValueError("unsupported CPOS core ordering")
    expected_stored = HEADER_SIZE + spectrum_bins * 4
    expected_core = expected_stored + spectrum_bins * 4
    expected_size = expected_core + core_compressed_size
    if (
        true_counts_offset != HEADER_SIZE
        or stored_counts_offset != expected_stored
        or core_offset != expected_core
        or file_size != expected_size
        or file_size != len(view)
    ):
        raise ValueError("invalid CPOS section layout")
    if verify_checksum:
        actual = zlib.crc32(view[HEADER_SIZE:]) & UINT32_MAX
        if actual != payload_crc32:
            raise ValueError(
                f"CPOS checksum mismatch: expected {payload_crc32:08x}, "
                f"got {actual:08x}",
            )
    return CposHeader(
        container_version=(container_major, container_minor),
        algorithm_version=(
            algorithm_major,
            algorithm_minor,
            algorithm_patch,
        ),
        header_size=header_size,
        flags=flags,
        original_point_count=original_count,
        stored_point_count=stored_count,
        target_point_count=target_count,
        exact_point_count=exact_count,
        spectrum_bin_count=spectrum_bins,
        fine_spectrum_bin_count=fine_spectrum_bins,
        spectrum_min_da=spectrum_min,
        spectrum_max_da=spectrum_max,
        spectrum_bin_da=(
            float(spectrum_max) - float(spectrum_min)
        ) / spectrum_bins,
        fine_spectrum_bin_da=(
            float(spectrum_max) - float(spectrum_min)
        ) / fine_spectrum_bins,
        allocation_exponent=allocation_exponent,
        default_noise=default_noise,
        seed=seed,
        minimum=(xmin, ymin, zmin),
        maximum=(xmax, ymax, zmax),
        core_method=core_method,
        axis_order=(axis_x, axis_y, axis_z),
        true_counts_offset=true_counts_offset,
        stored_counts_offset=stored_counts_offset,
        core_offset=core_offset,
        core_compressed_size=core_compressed_size,
        core_uncompressed_size=core_uncompressed_size,
        file_size=file_size,
        payload_crc32=payload_crc32,
    )


def _read_counts(
    view: memoryview,
    offset: int,
    count: int,
) -> np.ndarray:
    return np.frombuffer(
        view,
        dtype="<u4",
        count=count,
        offset=offset,
    ).copy()


def _decode_core(
    data: bytes,
    header: CposHeader,
    stored_counts: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if data[:4] != b"H12D" or len(data) < 28:
        raise ValueError("invalid CPOS hybrid core")
    count, exact_count, fine_count, active_count = struct.unpack_from(
        "<QQII",
        data,
        4,
    )
    active = np.flatnonzero(stored_counts)
    if (
        count != header.stored_point_count
        or exact_count != header.exact_point_count
        or fine_count != header.fine_spectrum_bin_count
        or active_count != len(active)
    ):
        raise ValueError("CPOS hybrid core metadata mismatch")
    offset = 28
    fine_bytes = fine_count * 4
    fine_counts = np.frombuffer(
        data,
        dtype="<u4",
        count=fine_count,
        offset=offset,
    ).copy()
    offset += fine_bytes
    widths = np.frombuffer(
        data,
        dtype=np.uint8,
        count=active_count,
        offset=offset,
    )
    offset += active_count
    unary_lengths = np.frombuffer(
        data,
        dtype="<u8",
        count=active_count,
        offset=offset,
    )
    offset += active_count * 8
    remainder_bytes = sum(
        ((int(stored_counts[bin_index]) + 7) // 8) * int(width)
        for bin_index, width in zip(active, widths, strict=True)
    )
    unary_bytes = sum((int(length) + 7) // 8 for length in unary_lengths)
    remainder_cursor = offset
    unary_cursor = remainder_cursor + remainder_bytes
    unary_end = unary_cursor + unary_bytes
    mass_size = ((int(exact_count) + 7) // 8) * BITS
    if unary_end + mass_size != len(data):
        raise ValueError("invalid CPOS hybrid core length")

    positions = np.empty((count, 3), dtype=np.uint16)
    cursor = 0
    for active_index, (_, _, end) in enumerate(_group_slices(stored_counts)):
        size = end - cursor
        width = int(widths[active_index])
        remainder_size = ((size + 7) // 8) * width
        remainder = _unpack_bitplanes(
            data[remainder_cursor:remainder_cursor + remainder_size],
            size,
            width,
        )
        remainder_cursor += remainder_size
        unary_length = int(unary_lengths[active_index])
        unary_size = (unary_length + 7) // 8
        unary = np.unpackbits(
            np.frombuffer(
                data,
                dtype=np.uint8,
                count=unary_size,
                offset=unary_cursor,
            ),
            bitorder="little",
        )[:unary_length]
        unary_cursor += unary_size
        ends = np.flatnonzero(unary).astype(np.int64)
        if len(ends) != size:
            raise ValueError("invalid CPOS Rice unary stream")
        previous = np.concatenate((
            np.array([-1], dtype=np.int64),
            ends[:-1],
        ))
        quotient = (ends - previous - 1).astype(np.uint64)
        gaps = (quotient << np.uint64(width)) | remainder
        positions[cursor:end] = _spatial_morton_inverse(
            np.cumsum(gaps, dtype=np.uint64),
        )
        cursor = end
    exact_masses = _unpack_bitplanes(
        data[unary_end:],
        int(exact_count),
        BITS,
    ).astype(np.uint16)
    return positions, exact_masses, fine_counts


def decode_retained(
    data: bytes | bytearray | memoryview,
) -> RetainedCloud:
    """Decode retained spatial seeds and rare-bin mass tuples."""
    header = inspect(data)
    view = memoryview(data).cast("B")
    true_counts = _read_counts(
        view,
        header.true_counts_offset,
        header.spectrum_bin_count,
    )
    stored_counts = _read_counts(
        view,
        header.stored_counts_offset,
        header.spectrum_bin_count,
    )
    if (
        int(true_counts.sum(dtype=np.uint64)) != header.original_point_count
        or int(stored_counts.sum(dtype=np.uint64)) != header.stored_point_count
        or np.any(stored_counts > true_counts)
    ):
        raise ValueError("CPOS coarse histograms do not match the header")
    exact_bins = (true_counts > 0) & (true_counts == stored_counts)
    if int(true_counts[exact_bins].sum(dtype=np.uint64)) != header.exact_point_count:
        raise ValueError("CPOS exact point count does not match its histograms")
    compressed = bytes(
        view[
            header.core_offset:
            header.core_offset + header.core_compressed_size
        ],
    )
    try:
        core = zlib.decompress(compressed)
    except zlib.error as error:
        raise ValueError("invalid CPOS compressed core") from error
    if len(core) != header.core_uncompressed_size:
        raise ValueError("CPOS core size mismatch")
    positions, exact_masses, fine_counts = _decode_core(
        core,
        header,
        stored_counts,
    )
    if int(fine_counts.sum(dtype=np.uint64)) != header.original_point_count:
        raise ValueError("CPOS fine histogram does not match point count")
    bins = np.repeat(
        np.arange(header.spectrum_bin_count, dtype=np.uint32),
        stored_counts.astype(np.int64),
    )
    return RetainedCloud(
        header=header,
        quantized_positions=positions,
        exact_quantized_masses=exact_masses,
        bins=bins,
        true_counts=true_counts,
        stored_counts=stored_counts,
        fine_counts=fine_counts,
    )


def _noise_mode(noise: str | int | None, default: int) -> int:
    if noise is None:
        return default
    if isinstance(noise, str):
        mapping = {
            "none": NOISE_NONE,
            "uniform": NOISE_UNIFORM,
            "gaussian": NOISE_GAUSSIAN,
        }
        if noise not in mapping:
            raise ValueError("noise must be 'none', 'uniform', or 'gaussian'")
        return mapping[noise]
    if noise in (NOISE_NONE, NOISE_UNIFORM, NOISE_GAUSSIAN):
        return int(noise)
    raise ValueError("invalid noise mode")


def _hash_uniform(
    start: int,
    count: int,
    seed: int,
    bin_index: int,
    dimension: int,
) -> np.ndarray:
    index = np.arange(start, start + count, dtype=np.uint64)
    value = (
        index * np.uint64(0x9E3779B1)
        + np.uint64(seed & UINT32_MAX)
        + np.uint64((bin_index * 0x85EBCA6B) & UINT32_MAX)
        + np.uint64((dimension * 0xC2B2AE35) & UINT32_MAX)
    ) & np.uint64(UINT32_MAX)
    value ^= value >> np.uint64(16)
    value = (value * np.uint64(0x7FEB352D)) & np.uint64(UINT32_MAX)
    value ^= value >> np.uint64(15)
    value = (value * np.uint64(0x846CA68B)) & np.uint64(UINT32_MAX)
    value ^= value >> np.uint64(16)
    return value.astype(np.float64) / (UINT32_MAX + 1.0)


def _position_noise(
    start: int,
    count: int,
    seed: int,
    bin_index: int,
    mode: int,
) -> np.ndarray:
    if mode == NOISE_NONE:
        return np.zeros((count, 3), dtype=np.float64)
    uniforms = np.column_stack([
        _hash_uniform(start, count, seed, bin_index, dimension)
        for dimension in range(3)
    ])
    if mode == NOISE_UNIFORM:
        return uniforms - 0.5
    companion = np.column_stack([
        _hash_uniform(
            start,
            count,
            seed ^ 0xA511E9B3,
            bin_index,
            dimension,
        )
        for dimension in range(3)
    ])
    gaussian = np.sqrt(-2.0 * np.log(np.maximum(uniforms, 1e-12))) * np.cos(
        2.0 * np.pi * companion,
    )
    return np.clip(gaussian * 0.22, -0.5, 0.5)


def _coprime_multiplier(total: int, seed: int, bin_index: int) -> int:
    candidate = (
        (seed ^ (bin_index * 0x9E3779B1)) & ((1 << 20) - 1)
    ) | 1
    while math.gcd(candidate, total) != 1:
        candidate = (candidate + 2) & ((1 << 20) - 1)
        if candidate == 0:
            candidate = 1
    return candidate


def _fill_common_masses(
    output: np.ndarray,
    fine_counts: np.ndarray,
    fine_start: int,
    total: int,
    fine_width: float,
    seed: int,
    bin_index: int,
) -> None:
    histogram = fine_counts
    cumulative = np.cumsum(histogram, dtype=np.int64)
    if not len(cumulative) or int(cumulative[-1]) != total:
        raise ValueError("CPOS fine and coarse histograms disagree")
    multiplier = _coprime_multiplier(total, seed, bin_index)
    offset = (
        (seed ^ (bin_index * 0x85EBCA6B)) & UINT32_MAX
    ) % total
    chunk_size = 1_000_000
    for start in range(0, total, chunk_size):
        size = min(chunk_size, total - start)
        index = np.arange(start, start + size, dtype=np.uint64)
        ranks = (
            index * np.uint64(multiplier) + np.uint64(offset)
        ) % np.uint64(total)
        local_bins = np.searchsorted(
            cumulative,
            ranks.astype(np.int64),
            side="right",
        )
        within = _hash_uniform(
            start,
            size,
            seed ^ 0xD1B54A35,
            bin_index,
            3,
        )
        # Keep float32 rounding comfortably away from fine-bin boundaries.
        within = 0.1 + 0.8 * within
        output[start:start + size] = (
            SPECTRUM_MIN_DA
            + (fine_start + local_bins + within) * fine_width
        ).astype(np.float32)


def decode_cloud(
    data: bytes | bytearray | memoryview,
    *,
    noise: str | int | None = None,
) -> DecodedCloud:
    """Decode and deterministically restore the original number of ions."""
    retained = decode_retained(data)
    header = retained.header
    mode = _noise_mode(noise, header.default_noise)
    minimum = np.asarray(header.minimum, dtype=np.float64)
    maximum = np.asarray(header.maximum, dtype=np.float64)
    extent = maximum - minimum
    fine_per_coarse = int(round(
        header.spectrum_bin_da / header.fine_spectrum_bin_da,
    ))

    output = np.empty((header.original_point_count, 4), dtype=np.float32)
    exact = np.zeros(header.original_point_count, dtype=np.bool_)
    output_bins = np.empty(header.original_point_count, dtype=np.uint32)
    seed_cursor = 0
    exact_mass_cursor = 0
    output_cursor = 0
    for bin_index in np.flatnonzero(retained.true_counts):
        total = int(retained.true_counts[bin_index])
        stored = int(retained.stored_counts[bin_index])
        seeds = retained.quantized_positions[
            seed_cursor:seed_cursor + stored
        ]
        destination = output[output_cursor:output_cursor + total]
        exact_bin = stored == total
        if exact_bin:
            destination[:, :3] = (
                minimum + seeds.astype(np.float64) / MASK12 * extent
            ).astype(np.float32)
            qmass = retained.exact_quantized_masses[
                exact_mass_cursor:exact_mass_cursor + total
            ].astype(np.float64)
            lower = SPECTRUM_MIN_DA + bin_index * header.spectrum_bin_da
            upper = lower + header.spectrum_bin_da
            mass = lower + qmass / MASK12 * header.spectrum_bin_da
            destination[:, 3] = np.clip(
                mass,
                np.nextafter(lower, upper),
                upper - header.spectrum_bin_da / (MASK12 * 2),
            ).astype(np.float32)
            exact[output_cursor:output_cursor + total] = True
            exact_mass_cursor += total
        else:
            destination[:stored, :3] = (
                minimum + seeds.astype(np.float64) / MASK12 * extent
            ).astype(np.float32)
            synthesized = total - stored
            if synthesized:
                parents = np.floor(
                    (np.arange(synthesized, dtype=np.float64) + 0.5)
                    * stored
                    / synthesized,
                ).astype(np.int64)
                chunk_size = 1_000_000
                for start in range(0, synthesized, chunk_size):
                    size = min(chunk_size, synthesized - start)
                    values = seeds[parents[start:start + size]].astype(
                        np.float64,
                    )
                    values += _position_noise(
                        start,
                        size,
                        header.seed,
                        int(bin_index),
                        mode,
                    )
                    values = np.clip(values, 0, MASK12)
                    destination[
                        stored + start:stored + start + size,
                        :3,
                    ] = (
                        minimum + values / MASK12 * extent
                    ).astype(np.float32)
            fine_start = bin_index * fine_per_coarse
            _fill_common_masses(
                destination[:, 3],
                retained.fine_counts[
                    fine_start:fine_start + fine_per_coarse
                ],
                fine_start,
                total,
                header.fine_spectrum_bin_da,
                header.seed,
                int(bin_index),
            )
        output_bins[output_cursor:output_cursor + total] = bin_index
        seed_cursor += stored
        output_cursor += total
    if (
        seed_cursor != header.stored_point_count
        or exact_mass_cursor != header.exact_point_count
        or output_cursor != header.original_point_count
    ):
        raise AssertionError("decoded CPOS point counts do not match")
    return DecodedCloud(
        header=header,
        points=output,
        exact=exact,
        bins=output_bins,
        true_counts=retained.true_counts,
        stored_counts=retained.stored_counts,
        fine_counts=retained.fine_counts,
    )


def decode(
    data: bytes | bytearray | memoryview,
    *,
    noise: str | int | None = None,
) -> np.ndarray:
    """Decode CPOS into an ``N × 4`` float32 array."""
    return decode_cloud(data, noise=noise).points


def spectrum_counts(
    data: bytes | bytearray | memoryview,
) -> tuple[np.ndarray, np.ndarray]:
    """Return copies of the source and retained coarse mass histograms."""
    retained = decode_retained(data)
    return retained.true_counts.copy(), retained.stored_counts.copy()
