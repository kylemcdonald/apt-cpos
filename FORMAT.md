# CPOS beta binary format

CPOS beta is a little-endian, fixed-budget hybrid format for four-column APT
`.POS` data.

## Beta policy

The numeric identifiers are frozen at container `1.0` and codec `1.0.0` until
the format is approved. During the beta they do not promise compatibility.
Readers accept only the exact layout documented here. They do not contain
migration, fallback, or earlier-layout decoding paths, so all CPOS files made
by earlier implementations are rejected even if they carry the same numeric
identifiers.

## File layout

```text
224-byte header
source coarse histogram       3,000 × uint32
retained-seed histogram       3,000 × uint32
Deflate-compressed hybrid core
```

The CRC32 covers every byte after the header.

## Header

| Offset | Size | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 4 | bytes | magic `CPOS` |
| 4 | 4 | 2 × uint16 | frozen container identifier (`1`, `0`) |
| 8 | 6 | 3 × uint16 | frozen codec identifier (`1`, `0`, `0`) |
| 14 | 2 | uint16 | header size (`224`) |
| 16 | 4 | uint32 | flags (`3`) |
| 20 | 8 | uint64 | original ion count |
| 28 | 8 | uint64 | retained spatial-seed count |
| 36 | 8 | uint64 | requested target seed count |
| 44 | 8 | uint64 | complete rare-ion tuple count |
| 52 | 4 | uint32 | coarse spectrum bins (`3,000`) |
| 56 | 4 | uint32 | fine spectrum bins (`150,000`) |
| 60 | 20 | 5 × float32 | spectrum min/max, coarse/fine widths, allocation exponent |
| 80 | 4 | uint32 | default dither mode |
| 84 | 8 | uint64 | deterministic synthesis seed |
| 92 | 24 | 6 × float32 | spatial minima, then spatial maxima |
| 116 | 1 | uint8 | core method (`2`) |
| 117 | 3 | 3 × uint8 | spatial axis order (`0`, `1`, `2`) |
| 120 | 48 | 6 × uint64 | source-count offset, seed-count offset, core offset, compressed core size, uncompressed core size, file size |
| 168 | 4 | uint32 | payload CRC32 |
| 172 | 4 | uint32 | reserved, zero |
| 176 | 48 | bytes | reserved, zero |

Decoders derive canonical spectrum widths from the range and bin counts. The
stored float32 widths are validation metadata.

## Allocation and rare bins

The coarse histogram covers `[0, 300)` Da in 0.1 Da bins. Out-of-range values
are clamped into the first or final bin.

If coarse bin `i` contains `c_i` ions, its seed quota is proportional to
`c_i ^ 0.75`, capped at `c_i`, with one seed reserved for every active bin.
Deterministic largest remainders make the quotas sum to the target.

A bin is rare/exact when its quota equals its source count. Every ion in that
bin retains its 12-bit spatial tuple and a 12-bit mass residual within the
0.1 Da bin. A bin is common/distributed when its quota is smaller than its
source count. Common bins retain spatial seeds but reconstruct masses from the
fine spectrum.

## Hybrid core

After Deflate decompression:

```text
"H12D"                              4 bytes
retained spatial-seed count         uint64
complete rare-ion tuple count       uint64
fine spectrum-bin count             uint32
active coarse-bin count             uint32
fine source histogram               fine_count × uint32
Rice remainder widths               active_count × uint8
Rice unary bit lengths              active_count × uint64
spatial remainder bitplanes         variable
spatial unary streams               variable
rare-bin mass-residual bitplanes    ceil(exact_count / 8) × 12
```

Spatial values are globally quantized to unsigned 12-bit values. Within every
coarse mass bin, points are sorted by their 36-bit 3D Morton key. Evenly
spaced ranks are selected according to the bin quota. Sorted Morton gaps use
the per-bin Rice width that minimizes the stream; remainders and rare-bin
masses are stored as aligned bitplanes.

The fine histogram covers `[0, 300)` Da at 0.002 Da. It stores the complete
source distribution and therefore has a total equal to the original ion
count.

## Expansion

Rare bins decode directly from their retained 12-bit tuples.

For each common bin:

1. emit retained 12-bit spatial seeds;
2. distribute synthesized positions evenly over those seeds;
3. add deterministic sub-cell spatial dither;
4. generate exactly the stored number of masses from every 0.002 Da fine bin;
5. use a deterministic coprime permutation to avoid correlating sorted mass
   ranks with Morton-sorted positions.

The result has exactly the source ion count and exact 0.1 Da counts. Common
bins also reproduce the exact stored 0.002 Da count distribution. Rare-bin
mass values can differ at a small number of 0.002 Da boundaries because their
stored representation is the finer 12-bit local residual rather than the
histogram bin center.

CPOS does not recover acquisition order or discarded sub-seed spatial detail.
