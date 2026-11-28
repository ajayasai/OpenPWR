# Forecasting primary pressure and coolant temperature during startup

OpenPWR v0.18 adds a forecast that starts from the latest instrument reading. Across the previously reserved Shippingport windows and a separately measured Combustion Engineering PWR heatup, the forecast reduced root-mean-square error (RMSE) for both quantities relative to carrying the last reading forward. The independent result describes one anonymized pre-power heatup. [Interactive results](https://ajayasai.github.io/OpenPWR/startup-evidence.html#startup-transfer) · [Download the row-level comparison](result.json)

| Event and forecast window | Signal | Readings | Forecast RMSE | Last-reading RMSE | Reduction |
| --- | --- | ---: | ---: | ---: | ---: |
| Shippingport, two reserved windows | Primary pressure | 10 | 0.152 MPa | 0.211 MPa | 27.9% |
| Shippingport, two reserved windows | Mean coolant temperature | 9 | 8.11 °C | 8.56 °C | 5.3% |
| Independent C-E heatup, one hour ahead | Primary pressure | 22 | 0.464 MPa | 0.980 MPa | 52.7% |
| Independent C-E heatup, one hour ahead | Mean coolant temperature | 22 | 7.46 °C | 12.19 °C | 38.8% |
| Independent C-E heatup, four hours ahead | Primary pressure | 19 | 3.236 MPa | 3.927 MPa | 17.6% |
| Independent C-E heatup, four hours ahead | Mean coolant temperature | 19 | 36.63 °C | 43.70 °C | 16.2% |

The first four rows were the registered success criteria. The four-hour results show how quickly absolute error grows with lead time. Temperature and pressure receive separate scores, each calculated on identical forecast origins and observation times for both methods. [Frozen scoring protocol](https://github.com/ajayasai/OpenPWR/blob/01b91619b80f4d0e51aa6492d57325088704e380/validation/startup_transfer/protocol.json)

## What changed

With one instrument reading, the forecast initializes its rate of change from the previous native Shippingport run. With two or more readings, it estimates that rate from the last two observations of the same instrument. It projects the rate forward as it decays toward zero. Development data selected a one-hour decay time for both instruments. The forecast and last-reading baseline receive identical measurement histories. This is an additional measurement-conditioned prediction mode. The native open-loop trajectories have their own verification and measured comparisons. [Forecast equation, units and CLI](model-notes.md) · [Earlier open-loop comparison](../shippingport_development/README.md)

## Held readings and limitations

Shippingport's two windows and their values had previously been published. The fitter used only initialization and development readings outside both windows. Neither forecast was updated during a window. The entire coolant-temperature gain comes from the single early observation. With two equal preceding readings, the forecast exactly matched persistence on every terminal observation for both instruments. [Station archive](https://digital.library.unt.edu/ark:/67531/metadc1240466/)

For the independent test, the operating record came from Figure 3-1 of EPRI report 3002003085. EPRI identifies it as a measured heatup of a Combustion Engineering PWR. Its unit name, date, raw sensor samples and sensor uncertainties are unavailable. Pressure was read in psig and converted to absolute MPa. The mean of the plotted hot- and cold-leg temperatures represents bulk coolant temperature in this comparison. Half a plotted line width corresponds to approximately 0.10 MPa or 1.49 °C. [Original EPRI report](https://restservice.epri.com/publicdownload/000000003002003085/0/Product) · [Source, extraction and uncertainty](ce_heatup/README.md)

The independent fixture was prepared separately from model development. The algorithm, parameters and scorer were frozen before its 23 pairs of hourly readings were released for scoring. At each issue time, only readings up to that hour were available to either forecast. A past target could enter a later forecast only after its observation time. Dropping any one pair still favored the forecast on both independent-event channels at both leads. The overlapping four-hour forecasts are correlated. Neither horizon evaluates an entire unobserved cold-to-full-power startup. [Frozen candidate](https://github.com/ajayasai/OpenPWR/tree/6b58197efae7a7150cdeb719d19fbb214d67dc0d/validation/startup_transfer) · [Input fingerprints](lock.json)

A separate calculation from the original °F and psig readings reproduced all four C-E scores. A post-hoc sensitivity check allowed every plotted reading, including forecast inputs, to move independently by half a line width plus its rounding allowance. The forecast retained a positive mean-square-error advantage on both quantities at both leads within those bounds. Sensor error and uncertainty in the time axis remain unquantified. [Independent audit and assumptions](ce_heatup/README.md)

## Reproduction

From the repository root, use Python 3 to reproduce the fitted parameters and every comparison point. The scoring run requires only the standard library and the committed observations. The source extractor also runs separately on the publisher's PDF.

```sh
python validation/startup_transfer/model.py --check
python validation/startup_transfer/compare.py --check
python -m unittest discover -s validation/tests -p "test_startup_transfer*.py"
```

Use `python validation/startup_transfer/model.py --forecast readings.json` with your own timestamped history. The [input example](model-notes.md) gives the fields and units.
