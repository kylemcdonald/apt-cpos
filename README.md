# cpos

`cpos` is a fixed-budget lossy codec for four-column Atom Probe `.POS` files.
It is designed to preserve the full ion count, rare-ion detail, mass-spectrum
shape, and point-cloud appearance in a roughly 10 MB browser-friendly file.

The CPOS beta uses a hybrid representation:

- quantize positions to 12 bits;
- retain at most 4,000,000 spatial seeds using the mass-aware sublinear
  allocator developed on `research/lossy-4m`;
- retain every ion in rare 0.1 Da bins, including a 12-bit mass residual local
  to that bin;
- represent common-bin masses with the exact source histogram at 0.002 Da;
- Morton-sort and Rice-code spatial gaps, bitplane-code exact masses, and
  Deflate the combined core;
- deterministically synthesize only common-bin ions until the original ion
  count is restored.

The 0.1 Da-local mass quantizer has a step of about 0.000024 Da. This replaces
the lossy-4m experiment's whole-file 12-bit mass quantizer, whose approximately
0.043 Da steps on the Ga test file destroyed fine spectrum structure.

## Python

```bash
python3 -m pip install -e .
cpos encode input.pos output.cpos
cpos inspect output.cpos
cpos decode output.cpos reconstructed.pos
```

The default target is 4,000,000 retained spatial seeds. `--target-points` can
override it.

```python
from cpos import decode, decode_cloud, encode

payload = encode(points)
reconstructed = decode(payload)
assert len(reconstructed) == len(points)

cloud = decode_cloud(payload)
print(cloud.header.exact_point_count)
print(cloud.exact)  # true only for complete rare-ion tuples
```

`decode_cloud` also exposes the coarse source/seed histograms, the exact
0.002 Da source histogram, coarse mass-bin indices, and provenance flags.

## Rangefinder

[`javascript/cpos.js`](javascript/cpos.js) is the dependency-free browser
decoder. Rangefinder vendors the same decoder. Dropped CPOS beta files expand
to the source ion count before analysis and rendering. Rangefinder uses the
stored 0.002 Da source spectrum for its quick RRNG path.

## Beta compatibility

The project and file identifiers remain at package `1.0.0`, container `1.0`,
and codec `1.0.0` throughout this beta. They will not be bumped until the
format is approved.

There is deliberately no backward-compatibility path. The encoder and both
decoders understand only the current 224-byte hybrid layout. Files made by
earlier CPOS implementations are rejected, including earlier beta files that
used the same numeric identifiers.

The Node wrapper uses the Python reference encoder and the JavaScript decoder:

```bash
node javascript/cli.mjs encode input.pos output.cpos
node javascript/cli.mjs decode output.cpos reconstructed.pos
```

## Acceptance data

For `86a2fa56-8593-4856-bd42-b73716197abf.POS`:

- source and decoded count: 8,657,555 ions;
- CPOS size: 10,257,324 bytes (9.78 MiB);
- retained spatial seeds: 4,000,000;
- complete rare-ion tuples: 895,899;
- 68.5–69.3 Da source and decoded count: 33,637;
- 0.01 Da Ga-window histogram correlation: 0.9999993;
- 32³ spatial Jensen–Shannon divergence: 0.00001259 bits.

A 29,810,068-ion input encodes to 9,392,088 bytes and decodes to all
29,810,068 ions. A deliberately difficult dense-background 20,949,148-ion
input encodes to 12,318,515 bytes.

## Tests

```bash
python3 -m pytest
```

The tests cover allocation, exact rare-bin tuples, common-bin spectrum
restoration, original-count expansion, no-decimation behavior, checksums, and
strict current-schema rejection.

See [FORMAT.md](FORMAT.md) for the binary layout and beta policy.
