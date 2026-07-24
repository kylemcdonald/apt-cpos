from __future__ import annotations

import struct
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from cpos import (
    ALGORITHM_VERSION,
    CONTAINER_VERSION,
    CposVersionError,
    decode,
    decode_cloud,
    decode_retained,
    encode,
    inspect,
)
from cpos.codec import HEADER_SIZE, allocate_sublinear, spectrum_counts

ROOT = Path(__file__).resolve().parents[1]


def synthetic_points(seed: int = 7, count: int = 30_000) -> np.ndarray:
    rng = np.random.default_rng(seed)
    xyz = rng.normal(size=(count, 3)).astype(np.float32)
    xyz[:, 0] = xyz[:, 0] * 12.0 + 4.0
    xyz[:, 1] *= 8.0
    xyz[:, 2] = xyz[:, 2] * 35.0 + 80.0
    categories = rng.choice(5, size=count, p=[0.54, 0.23, 0.12, 0.08, 0.03])
    centers = np.array([6.0, 27.98, 55.94, 119.0, 171.5], dtype=np.float32)
    mass = centers[categories] + rng.normal(0, 0.025, size=count)
    return np.column_stack([xyz, mass]).astype(np.float32)


def histogram(points: np.ndarray, width: float) -> np.ndarray:
    bins = np.clip(
        np.floor(points[:, 3].astype(np.float64) / width).astype(np.int64),
        0,
        int(round(300 / width)) - 1,
    )
    return np.bincount(bins, minlength=int(round(300 / width)))


def test_versioned_header_and_full_count_decode():
    points = synthetic_points()
    payload = encode(points, target_points=4_999)
    header = inspect(payload)
    cloud = decode_cloud(payload)
    original_counts, retained_counts = spectrum_counts(payload)

    assert payload[:4] == b"CPOS"
    assert header.container_version == CONTAINER_VERSION
    assert header.algorithm_version == ALGORITHM_VERSION
    assert header.header_size == HEADER_SIZE
    assert header.original_point_count == len(points)
    assert header.stored_point_count == 4_999
    assert header.exact_point_count <= header.stored_point_count
    assert header.file_size == len(payload)
    assert cloud.points.shape == points.shape
    assert cloud.points.dtype == np.float32
    assert np.isfinite(cloud.points).all()
    assert int(cloud.exact.sum()) == header.exact_point_count
    assert int(original_counts.sum()) == len(points)
    assert int(retained_counts.sum()) == header.stored_point_count
    assert np.all(retained_counts <= original_counts)
    assert np.array_equal(histogram(points, 0.1), histogram(cloud.points, 0.1))
    source_min = points[:, :3].min(0)
    source_max = points[:, :3].max(0)
    assert np.allclose(np.asarray(header.minimum), source_min)
    assert np.allclose(np.asarray(header.maximum), source_max)
    assert np.all(cloud.points[:, :3].min(0) >= source_min - 0.01)
    assert np.all(cloud.points[:, :3].max(0) <= source_max + 0.01)


def test_rare_bins_are_exact_local_12_bit_tuples_and_common_spectrum_is_fine():
    rng = np.random.default_rng(19)
    common_count = 40_000
    rare_per_bin = 120
    rare_centers = np.arange(40.05, 80.0, 0.2)
    common = np.empty((common_count, 4), dtype=np.float32)
    common[:, :3] = rng.normal(size=(common_count, 3))
    common[:, 3] = 27.05 + rng.normal(0, 0.018, common_count)
    rare = np.empty((len(rare_centers) * rare_per_bin, 4), dtype=np.float32)
    rare[:, :3] = rng.normal(size=(len(rare), 3))
    rare[:, 3] = np.repeat(rare_centers, rare_per_bin)
    rare[:, 3] += rng.normal(0, 0.012, len(rare))
    points = np.concatenate((common, rare))

    payload = encode(points, target_points=30_000)
    retained = decode_retained(payload)
    cloud = decode_cloud(payload)
    exact_bins = (
        (retained.true_counts > 0)
        & (retained.true_counts == retained.stored_counts)
    )
    assert exact_bins.any()
    assert np.any(retained.stored_counts < retained.true_counts)
    assert int(retained.true_counts[exact_bins].sum()) == int(cloud.exact.sum())

    # A rare 68.9 Da feature is represented by local 12-bit mass values, not
    # the unusably coarse whole-file mass quantizer from the research codec.
    window = (points[:, 3] >= 68.5) & (points[:, 3] < 69.3)
    decoded_window = (
        (cloud.points[:, 3] >= 68.5)
        & (cloud.points[:, 3] < 69.3)
    )
    source_hist = np.histogram(
        points[window, 3],
        np.arange(68.5, 69.302, 0.002),
    )[0]
    decoded_hist = np.histogram(
        cloud.points[decoded_window, 3],
        np.arange(68.5, 69.302, 0.002),
    )[0]
    assert source_hist.sum() == decoded_hist.sum()
    assert np.abs(source_hist - decoded_hist).sum() <= 8

    # Common bins are reconstructed from the stored 0.002 Da distribution.
    assert np.array_equal(histogram(points, 0.002), histogram(cloud.points, 0.002))


def test_no_decimation_keeps_every_point_exact():
    points = synthetic_points(count=5_003)
    payload = encode(points, target_points=10_000)
    cloud = decode_cloud(payload)
    header = inspect(payload)
    assert header.stored_point_count == len(points)
    assert header.exact_point_count == len(points)
    assert cloud.exact.all()
    assert len(decode(payload)) == len(points)


def test_removed_beta_compatibility_aliases_are_not_accepted():
    points = synthetic_points(count=100)
    with pytest.raises(TypeError, match="max_points"):
        encode(points, max_points=50)
    header = inspect(encode(points, target_points=50))
    assert not hasattr(header, "max_points")


def test_sublinear_allocation_protects_rare_bins():
    counts = np.array([1, 4, 100, 10_000], dtype=np.int64)
    allocation = allocate_sublinear(counts, 1_000, 0.5)
    rates = allocation / counts
    assert allocation.sum() == 1_000
    assert np.all(allocation <= counts)
    assert np.all(rates[:-1] >= rates[1:])
    assert allocation[0] == counts[0]


def test_checksum_and_every_other_version_are_rejected():
    payload = bytearray(
        encode(synthetic_points(count=2_000), target_points=499)
    )

    corrupted = payload.copy()
    corrupted[-1] ^= 0x80
    with pytest.raises(ValueError, match="checksum mismatch"):
        inspect(corrupted)

    for offset, value, pattern in (
        (4, 2, "unsupported CPOS container"),
        (6, 1, "unsupported CPOS container"),
        (8, 2, "unsupported CPOS codec"),
        (10, 1, "unsupported CPOS codec"),
        (12, 1, "unsupported CPOS codec"),
    ):
        other_version = payload.copy()
        struct.pack_into("<H", other_version, offset, value)
        with pytest.raises(CposVersionError, match=pattern):
            inspect(other_version)

    earlier_beta_layout = payload.copy()
    struct.pack_into("<H", earlier_beta_layout, 14, 128)
    with pytest.raises(ValueError, match="unsupported CPOS header"):
        inspect(earlier_beta_layout)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_javascript_decoder_restores_the_source_count(tmp_path: Path):
    points = synthetic_points(count=12_003)
    cpos_path = tmp_path / "fixture.cpos"
    pos_path = tmp_path / "decoded.pos"
    cpos_path.write_bytes(encode(points, target_points=4_003))
    subprocess.run(
        [
            "node",
            str(ROOT / "javascript" / "cli.mjs"),
            "decode",
            str(cpos_path),
            str(pos_path),
        ],
        cwd=ROOT,
        check=True,
    )
    assert pos_path.stat().st_size == len(points) * 16
