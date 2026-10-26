# Measured plant-transient comparison: Krško 2005

This case compares a short native thermal/inventory replay with **measured plant instrument curves**, not another code's predictions. The source is [NUREG/IA-0221, Reactor Trip Analysis at Krško Nuclear Power Plant](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS122191/pdf/GOVPUB-Y3_N88-PURL-LPS122191.pdf), by A. Prošek and B. Mavko, published by the NRC in February 2010. The event occurred on 5 April 2005.

`measured.csv` contains 50 published sample times and 12 instrument channels from Figures 22–26, 29, 33–34, and 37–40, panel (a). The extraction reads the magenta measured vector paths. It excludes the blue `cal` curves. The source PDF is not bundled. `provenance.json` records its byte hash, page/figure mapping, units, transformations, scope, and limitations.

## What the comparison establishes

Measured pre-trip neutron power is used as a thermal-input proxy; measured steam and feedwater flows drive the secondary boundary. Primary pressure, hot/cold temperatures and secondary pressure are held out for comparison. Only the initial-state table is used to initialize and calibrate the nominal equilibrium. No transient fitting is performed.

The comparison ends at 15 seconds, before operator reopening and the reactor/SI event. This avoids using neutron-power readings as total decay heat, and avoids the source's identified post-trip flow-measurement problems. It does not validate kinetics, valve logic, electrical generation, emergency cooling, or full-event response.

**Plant validation remains inconclusive.** The original plant input deck, exact volumes/heat capacities, and instrument accuracy/delay data are not in the report. Generic OpenPWR geometry is explicitly retained and scaled by initial thermal power. The report presents the discrepancies without converting them into an accuracy claim or forcing a pass. A successful calculation proves that the comparison ran; it does not establish agreement with the plant.

## Important source correction

The pressure plots label their axis “MPa” but show bar-valued numbers: 144–162 in Figure 29 and 64–80 in Figures 33–34. The extractor multiplies the printed numbers by 0.1. Table 2 independently gives measured initial values of 15.48 MPa primary and 6.42/6.40 MPa secondary, confirming the conversion. Temperature plots are in kelvin; the CSV uses Celsius. Six decimal places in the CSV reflect a reproducible vector transform, not measurement precision.

## Reproduce the reference extraction

Install `pdfplumber==0.11.9` in a separate Python environment, then run:

```sh
python validation/krsko2005/extract.py --download
```

The download goes into ignored `artifacts/measured-transients/`. The extractor rejects a PDF with a different SHA-256, mismatched instrument/page identities, an unexpected number of samples, or a different acquisition grid. It writes the CSV and extraction diagnostics. Normal native comparisons use the checked-in CSV and do not need `pdfplumber` or an internet connection.

Numerical data are transcribed facts from the cited public report. Original extraction/comparison code is Apache-2.0; publisher artwork and prose are not redistributed or relicensed. The half-point extraction allowance and ±1 s acquisition allowance are **not** complete measurement uncertainties.

## Execute the native comparison

With the repository's Linux/WSL OpenModelica and FMPy engineering environment:

```sh
npm run engineering:measured -- --build
```

Inside an activated Linux/WSL engineering environment:

```sh
python -m unittest discover -s validation/krsko2005 -p test_reference.py
```

The outputs are `artifacts/modelica/KrskoTransient.fmu`, its `krsko-manifest.json`, and `artifacts/measured-validation.json`. Comparison without `--build` rejects stale source/data/metadata or changed FMU bytes. Normal comparison uses only stdlib and FMPy. The report includes error statistics at the eight acquired samples from 1 to 15 seconds, half-step refinement, independent boundary integrals, and uncalibrated geometry sensitivity. See [the measured validation guide](../../docs/MEASURED_VALIDATION.md) for the actual results and detailed limitations.
