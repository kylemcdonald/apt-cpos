from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from cpos import decode_cloud, encode, inspect
from cpos.io import read_pos

ROOT = Path(__file__).resolve().parents[1]
GA_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "uap-materials-article"
    / "src"
    / "data"
    / "86a2fa56-8593-4856-bd42-b73716197abf.POS"
)


@pytest.mark.skipif(not GA_SOURCE.exists(), reason="local Ga acceptance POS is absent")
def test_ga_file_size_count_and_fine_spectrum_acceptance():
    points = read_pos(GA_SOURCE)
    payload = encode(points)
    header = inspect(payload)
    decoded = decode_cloud(payload)

    assert len(points) == 8_657_555
    assert header.original_point_count == len(points)
    assert header.stored_point_count == 4_000_000
    assert len(decoded.points) == len(points)
    assert 8_000_000 <= len(payload) <= 13_000_000

    edges = np.arange(68.5, 69.305, 0.01)
    source = np.histogram(points[:, 3], edges)[0]
    reconstructed = np.histogram(decoded.points[:, 3], edges)[0]
    assert int(source.sum()) == 33_637
    assert int(reconstructed.sum()) == int(source.sum())
    assert np.corrcoef(source, reconstructed)[0, 1] > 0.9999


@pytest.mark.skipif(
    not GA_SOURCE.exists() or shutil.which("node") is None,
    reason="local Ga POS or Node is absent",
)
def test_browser_encoder_ga_file_acceptance(tmp_path: Path):
    cpos_path = tmp_path / "browser-ga.cpos"
    subprocess.run(
        [
            "node",
            str(ROOT / "javascript" / "cli.mjs"),
            "encode",
            str(GA_SOURCE),
            str(cpos_path),
            "--target-points",
            "4000000",
        ],
        cwd=ROOT,
        check=True,
    )
    payload = cpos_path.read_bytes()
    header = inspect(payload)
    decoded = decode_cloud(payload)
    points = read_pos(GA_SOURCE)

    assert header.original_point_count == 8_657_555
    assert header.stored_point_count == 4_000_000
    assert len(decoded.points) == len(points)
    assert 8_000_000 <= len(payload) <= 13_000_000

    edges = np.arange(68.5, 69.305, 0.01)
    source = np.histogram(points[:, 3], edges)[0]
    reconstructed = np.histogram(decoded.points[:, 3], edges)[0]
    assert int(source.sum()) == 33_637
    assert int(reconstructed.sum()) == int(source.sum())
    assert np.corrcoef(source, reconstructed)[0, 1] > 0.9999
