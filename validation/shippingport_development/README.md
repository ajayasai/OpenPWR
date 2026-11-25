# Shippingport conditioned startup

This assessment tests how closely the whole-plant model follows measured primary coolant temperature and reactor pressure during Shippingport's June 24–25, 1958 startup. Both measurements and predictions use the station's original elapsed time. The historic test took roughly 29 hours, including an interruption. OpenPWR's generic 1,000 MWe plant and Shippingport's original approximately 60 MWe plant have different inventories, equipment and operating histories. [Station report and scanned instrument tables](https://digital.library.unt.edu/ark:/67531/metadc1240466/) · [Original v0.16 comparison](../startup_holdout/README.md)

## Measured results

**The conditioned startup follows both measured signals substantially more closely than the generic run on their common reserved readings. Across all 19 reserved readings, persistence has lower root-mean-square error for both signals.** The predeclared criterion required improvement against both comparators for both signals. [Interactive comparison](https://ajayasai.github.io/OpenPWR/startup-evidence.html#shippingport-development) · [Complete numerical result](result.json) · [Frozen native prediction](native.json)

| Instrument and unit | Window | Readings | Conditioned RMSE | Persistence RMSE | Generic RMSE |
| --- | --- | ---: | ---: | ---: | ---: |
| Reactor pressure, MPa | Development | 42 | 0.431 | 0.756 | — |
| | Reserved interior | 4 | 0.205 | 0.320 | 13.670 |
| | Reserved terminal | 6 | 0.583 | 0.080 | — |
| | Both reserved blocks | 10 | 0.470 | 0.211 | — |
| Mean coolant temperature, °C | Development | 6 | 1.47 | 43.68 | — |
| | Reserved interior | 1 | 19.65 | 8.33 | 154.10 |
| | Reserved terminal | 8 | 8.22 | 8.59 | — |
| | Both reserved blocks | 9 | 10.15 | 8.56 | — |

The dash means the generic run does not cover every reading in that row. Each displayed comparison uses identical times. On the interior block, the conditioned model beats persistence on pressure. Its sole coolant-temperature prediction is 19.65 °C high. At that reading, 17:19 on June 24, Shippingport reported **96.11 °C and 1.963 MPa**. The conditioned model predicted **115.76 °C and 1.659 MPa**. The original generic run predicted **250.21 °C and 15.494 MPa**.

On the terminal block, pressure has a mean signed error of **−0.580 MPa**, compared with nearly steady observed pressure and a persistence RMSE of **0.080 MPa**. Terminal coolant-temperature predictions average **6.35 °C low**. Their RMSE of **8.22 °C** is slightly smaller than persistence's **8.59 °C**. Both reserved blocks together show why the development fit alone would overstate accuracy, especially for temperature.

## What the model receives

The `ShippingportStartup` Modelica case inherits `ContinuousPlant` and runs as one native instance over 104,400 seconds. Its initial bulk coolant temperature uses the first reported 190 °F at 13:18. Its initial primary pressure uses the first reported 400 psig at 14:05. Applying both values at the 13:00 log origin approximates the starting state from two asynchronous observations. Both input readings are excluded from every score.

The historical record lacks continuous heat-transfer and mass-flow measurements. The conditioned case supplies effective thermal and pressure-related inputs estimated using eligible development readings. These inputs describe the energy and inventory changes of this historical simulation. Their magnitudes are estimates and may absorb differences in plant size or equipment. The solver integrates its shared whole-plant balances throughout the run. [Fitting method, constraints and numerical checks](thermal-model.md) · [Estimated historical inputs](thermal-boundaries.json) · [Native case](../../models/ShippingportStartup.mo) · [Native runner](run_native.py)

## Which observations test the prediction

The split was published before the revised model was scored. Both endpoints of each reserved block are included. A developer had seen some early reserved readings while inspecting the public inventory before receiving the split. Those readings supplied no inputs to calibration or to selection of the boundary times and magnitudes. This retrospective assessment uses one previously published event. The first block is bracketed by development readings. The second starts after the final development observations and tests the continuation of the run. [Frozen protocol](https://github.com/ajayasai/OpenPWR/tree/b10094f85ca9fa3f8b474c5e336554cdc1377679/validation/shippingport_development)

| Instrument | Initialization | Development | June 24, 17:00–17:35 | June 25, 16:00–18:00 | Source-flagged |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reactor pressure | 1 | 42 | 4 | 6 | 1 |
| Average primary coolant temperature | 1 | 6 | 1 | 8 | 0 |

The two other transcribed channels, pressurizer temperature and loop 1A cold-leg temperature, supplied no observations for calibration or scoring. The primary pressure comparison uses absolute MPa with a standard-atmosphere gauge offset. The temperature comparison uses the arithmetic mean of the native hot and cold legs in °C. The station's averaging weights and measurement uncertainties are unknown. The linked transcriptions retain the gauge readings, Fahrenheit readings, page references and source flags. [Station observations](../startup_holdout/shippingport/observations.json) · [Unit conventions and transcription review](../startup_holdout/shippingport/README.md)

Each eligible observation has equal weight. Signed errors are predictions minus measurements. The persistence comparator holds the most recent earlier initialization or development reading of each instrument. It receives no updates inside either reserved block. The frozen generic model ends at 7.5 hours, so its comparison with the revised model uses only the same four pressure readings and one temperature reading in the first block. The score report also separates development fit, each reserved block, their union and all eligible readings. Individual measurements retain their acquisition times, units and source pages.

The native model, effective inputs, fitting code and numerical assessment were published together before examining the reserved-block scores. The scored run was rebuilt from that clean revision. [Frozen candidate](https://github.com/ajayasai/OpenPWR/tree/86dc3f20212182502ecfbe12eea9cf8da48131eb/validation/shippingport_development)

Station turbine synchronism was recorded with the generator breaker open. These two thermal response channels provide no validation of criticality, turbine dynamics, electrical loading, sustained full power or accuracy on another event.

## Reproduction

From the repository root, the following commands run the published assessment with the standard Python library.

```sh
python validation/shippingport_development/assess.py --development
python validation/shippingport_development/assess.py --check
python -m unittest discover -s validation/tests -p test_shippingport_development.py
```

The first command emits only the case-development inputs. The second checks the archived prediction and observation fingerprints, the frozen scoring protocol and the complete numerical result. On a clean native build, the following commands re-execute the historical case and compare all 1,741 retained samples with the published trajectory.

The frozen run identifies both its executable and its source revision. Two files changed when the generic and historical builds were separated. Their original Git bytes are included in the [frozen runner archive](frozen-runners-701d7d342354.zip). The [historical base class](model/ContinuousPlant.mo) retains the original candidate source bytes. The rebuild check verifies this class and the Shippingport specialization inside the newly compiled FMU, checks current build provenance, and compares the results with the original record.

```sh
npm run engineering:shippingport -- --build
python validation/shippingport_development/assess.py --repeat artifacts/shippingport-conditioned-native.json
```
