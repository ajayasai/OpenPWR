# Combustion Engineering PWR heatup

The Electric Power Research Institute (EPRI) published an anonymous U.S. Combustion Engineering PWR heatup in October 2014. The report identifies actual fatigue-monitoring records as its operating data. Figure 3-1 shows two reactor coolant leg temperatures and primary-system gauge pressure against the same elapsed-time axis. Its accompanying Table 3-2 describes a zero-power heatup. The publication omits the station name, acquisition date, complete sensor specifications and actuator histories. The observations cover the thermal portion of startup. [Original EPRI report, product 3002003085, §3.1.1 and Figure 3-1](https://restservice.epri.com/publicdownload/000000003002003085/0/Product#page=41)

## Measurements

The source figure spans 0–24 hours. The plotted record for at least one channel ends short of each boundary. We extracted every integer hour common to all three traces, hours 1 through 23. The saved time is measured from the source figure's zero. Each record preserves hot-leg and cold-leg temperatures in °F and pressure in psig. The comparison uses the arithmetic mean of the hot and cold legs as a proxy for bulk coolant temperature. Absolute pressure assumes an atmospheric offset of 0.101325 MPa. The report does not supply the local atmospheric pressure or a mass-weighted coolant average.

| Quantity | Conversion |
| --- | --- |
| Mean coolant temperature in °C | ((hot °F + cold °F) / 2 − 32) × 5/9 |
| Absolute pressure in MPa | 0.101325 + psig × 0.006894757293168 |

## Digitization and uncertainty

The PDF contains independent vector paths for both temperatures and pressure. Their centre lines remain separate even where one colored line covers the other. Absolute page coordinates, axis calibration and the three recorded path lengths are specified in [extract.py](extract.py). The script intersects each path with each hourly grid line, linearly interpolating between published drawing vertices. The gauge readings are rounded to whole psi and the leg temperatures to tenths of a degree Fahrenheit before conversion. These are readings from a graph. The exact acquisition times and unrounded instrument samples are unavailable.

Half the plotted line width represents approximately 1.49 °C for a leg temperature and 0.102 MPa for pressure. These numbers describe graphical resolution and should not be interpreted as statistical sensor uncertainties. An independent extraction from PDF drawing commands using decimal arithmetic matched all 23 pressure readings and all 23 hot-leg readings at the published precision. Two of the 23 cold-leg readings differed by 0.1 °F at rounding boundaries; the corresponding mean-temperature differences were at most 0.028 °C. Visual inspection confirmed the axes, legend and common time support. Raster checks at all 23 hours located each hot-leg and pressure mark within half a PDF point. In four instances the blue cold-leg trace was visually hidden by overpainting; the independent vector extraction verified it there.

## Post-hoc graphical sensitivity check

The independent [forecast audit](audit.py) calculates every C-E forecast again from the Fahrenheit and psig observations and the frozen parameters. It checks both horizons, all targets and the recorded root-mean-square error, mean absolute error, mean signed error and largest absolute error. It also bounds the effect of moving every graph reading up or down by up to half its stroke width plus half its rounding increment, equivalent to ±1.516 °C or ±0.1051 MPa. Each perturbed value is used consistently wherever the same reading enters a forecast or serves as a target.

Under this assumption, the reduction in mean squared error relative to carrying the last reading forward remains at least 63.77 °C² and 0.628 MPa² at one hour, and 490.30 °C² and 4.612 MPa² at four hours. The script obtains these conservative lower bounds by expanding the squared-error difference in the reading perturbations and bounding its linear and quadratic terms. This post-hoc check concerns vertical graphical resolution. Sensor bias, horizontal digitization error, sampling uncertainty and variation between events are outside its scope.

Run the audit from the repository root with Python and NumPy (included in the native engineering environment).

```sh
python validation/startup_transfer/ce_heatup/audit.py
```

## Reproduction and reuse

Download the report from the EPRI link above. With the open-source PyMuPDF package installed (the extraction used 1.27.2.2), run from the repository root:

```sh
python validation/startup_transfer/ce_heatup/extract.py /path/to/3002003085.pdf --check validation/startup_transfer/ce_heatup/observations.json
```

The numerical fixture SHA-256 is `9262a70a97c9c7e767b8cf358deeb9417ddff14ad7787f9f2765a7a38352c257`. The PDF page is number 41, printed page 3-3, with decoded contents SHA-256 `f76907f715ee2eca4ac35775e61c99e276932efa04cf4c4f6d139e199b60d3a0`. The audited download has SHA-256 `bc7f19ec848215301f958a39c0854d862c8dccecf1f96f6b60d66085ff734c10`. EPRI's delivery metadata can vary per download. Two copies with different document hashes yielded identical source-page content and numerical fixtures.

The source publication is © 2014 Electric Power Research Institute, Inc. The project distributes its own extraction code and sparse numerical observations and links to EPRI for the source PDF and original artwork.
