# Independent PACTEL pressurizer reference

`measured.csv` contains only the **red measured Pactel pressure curve** from Figure 5 of [NUREG/IA-0231](https://www.govinfo.gov/content/pkg/GOVPUB-Y3_N88-PURL-LPS124697/pdf/GOVPUB-Y3_N88-PURL-LPS124697.pdf), the 1998 ATWS-10 insurge/outsurge experiment. The black dashed TRACE calculation is excluded. This is independent of the Krško 2005 plant event.

This dataset supports a **conditional component comparison**, not full-plant validation. The source supplies measured initial pressure/level, vessel dimensions, operator times, average boundary flows, and an instrument pressure error bound. Exact inlet temperature, initialization temperatures and one-second flow/heater ramps are numerical assumptions from the source's published input appendix. They remain explicitly identified as such in `provenance.json`.

The report's discussion of pressure physics informs model development, so this is not a blind validation holdout. Fix parameters from published dimensions, properties and correlations before the first comparison. The measured pressure trace must not be used for automatic tuning.

The 491 points cover 5–495 s at a one-second **resampling** interval. The original acquisition cadence is not reported. The extractor reads the embedded figure image directly, checks its SHA-256 and plot geometry, selects red pixels, and interpolates only across at most five pixel columns. It applies no smoothing, response fit, pressure offset, or event-time alignment. The published peak and the tabulated insurge-stop time differ slightly and are both preserved.

The report gives a maximum pressure-measurement error of ±0.094 MPa. A separate conservative two-pixel extraction allowance corresponds to ±0.0143 MPa and ±1.20 s. Their additive pressure envelope is ±0.1083 MPa, with the separate time allowance, for a conditional comparison. These bounds have no stated probability distribution and do not quantify uncertainty in boundary conditions or model form. The 491 resampled positions are correlated readings of one curve, not independent raw samples; any coverage fraction is descriptive, not a confidence level. The spray-flow uncertainty reported for ATWS-21 must not be applied to ATWS-10.

Reproduce the numeric CSV with Python 3.10+, `pypdf==6.10.0`, and `Pillow==12.3.0`:

```sh
python validation/pactel1998/extract.py
python -m unittest discover -s validation/pactel1998 -p 'test_*.py'
```

The extractor downloads the fixed public report to ignored `artifacts/measured-transients/` if needed. Only numerical facts, provenance and original code are committed; the PDF, artwork and input-deck text are not redistributed.

The chosen reference addresses phase nonequilibrium and wall heat storage during a pressure transient. Krško's independent 1995/1997 MSIV events in NUREG/IA-0223 were considered, but the report does not publish the core-power, feedwater-flow and temperature histories needed for a measured-boundary full thermal replay. Substituting RELAP results or invented histories would weaken the comparison.
