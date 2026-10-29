# ATWS-11 reserved response protocol

**Historical v0.7 protocol.** The response was scored and published in v0.7.0. Reproduce the original frozen run from that tag. Later releases use [the post-unblinding comparison](post-unblinding-method.md); ATWS-11 is no longer held out from development. The original source, freeze, data and published result are preserved.

ATWS-11 is a different PACTEL experiment from the ATWS-10 development comparison. Its pressure response was withheld from the pressure-model developer during the v0.7 development cycle. The report's general discussion was already available. This is a development-separated component comparison, not historically blind external validation or operating-plant qualification.

The case and window were selected using the published input tables before extracting the response. [The protocol](holdout-protocol.json) records the selection time and predeclared inputs, numerical settings and scoring. [The provenance](holdout-provenance.json) identifies every measured value and inherited approximation.

## Selected scope

The native model runs from 0 to 295 s; measured comparisons cover 5 to 295 s. Table 2 starts draining at 297 s, but the report does not supply ATWS-11's outsurge mass-flow magnitude. No outflow has been inferred from the pressure curve. The later expansion response and full-event peak are excluded.

Table 1 supplies the 5.9 MPa initial pressure, 3.5 m liquid level and 0.217 kg/s insurge. Table 2 supplies heater shutdown at 100 s and insurge initiation at 119 s. One-second ramps, 547 K inlet/wall temperature and 547.64 K initial fluid temperature reuse the printed ATWS-10 input convention and are explicitly assumptions for ATWS-11. Facility core power is not deposited directly in the pressurizer.

The same compiled `OpenPWR.PactelPressurizer` model is used for both experiments, with the protocol's initial parameters supplied before FMI initialization. ATWS-11 pressure may not select coefficients, material properties, mesh, initial conditions, input timing, offsets or the model revision.

## Reproduce the reference

With Python, `pypdf` and Pillow available:

```sh
python validation/pactel1998/holdout_extract.py
python -m unittest discover -s validation/pactel1998 -p 'test_holdout.py'
```

The extractor verifies the primary PDF's SHA-256, page count, Figure 6 caption, image dimensions and plot frame. It reads the red measured path, excludes the black TRACE predictions and later response, rejects disjoint branches or excessive gaps, and never extrapolates. Re-extraction reproduced the committed CSV byte-for-byte.

The 291 positions on the one-second grid are correlated graphical readings, not 291 independent instrument samples. Six decimal places preserve extraction reproducibility, not measurement precision. The descriptive envelope combines the report's ±0.094 MPa instrument-error bound with a two-pixel vertical allowance and a separate two-pixel time window. The time window is clipped at the available reference endpoints. Input and model uncertainties remain incomplete; this is not a statistical confidence interval.

## Candidate freeze and scoring

The original candidate is frozen once, after model and numerical choices are complete and before the first ATWS-11 candidate comparison:

```sh
python validation/pactel1998/holdout_compare.py --freeze
```

This development action creates `holdout-freeze.json` and refuses to overwrite it. Users reproducing the published candidate must use the committed freeze; they must not regenerate it. The freeze binds model, wrapper, shared runner, both comparators, extraction code, reference, provenance and protocol. The subsequent FMU build manifest additionally binds the freeze and the compiled executable. Changed candidate sources fail before held-out execution.

In the `v0.7.0` checkout, the normal PACTEL build/comparison command evaluates the frozen model and includes the result as `holdoutComparison` in `artifacts/pressurizer-validation.json`:

```sh
npm run engineering:pressurizer -- --build
```

`run_holdout(build_manifest, fmu_path=...)` is also callable from Python. It compares 0.1 s and 0.05 s communication steps with the declared 1e-9 compiled solver tolerance, preserves exact boundary knots and checks independent mass/energy integrals against physical inventories. It reports raw pressure errors without offset correction or time alignment. Numerical acceptance and descriptive agreement with measurements are separate results; neither establishes full-plant validation.

Later model development may use the now-published response, but it must preserve the original freeze/result and identify subsequent ATWS-11 evaluations as post-unblinding. The original held-out status cannot be reset by rewriting the record.

### Pre-scoring initialization correction in v0.7

The first source freeze was withdrawn before any ATWS-11 candidate calculation. An independent audit found that the unrelated native auxiliary-feedwater latch missed an already-low steam-generator level at initialization. The original source is preserved in commit `1acbeb5`, and the original freeze bytes remain in `holdout-freeze-superseded-1.json`. The replacement freeze records its predecessor hash, source revision, withdrawal time and reason, and explicitly states that the prior candidate was never scored. The pressure equations, mesh choice, measured reference, protocol and scoring code were unchanged. This is a documented pre-scoring correction, not a reset after observing an unfavorable response.
