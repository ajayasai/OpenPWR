# An uninterrupted native startup against two measured plant records

OpenPWR runs its generic 1,000 MWe plant from a cold, offline state through heatup, grid connection and rated generation. One compiled `ContinuousPlant` instance evolves the primary pressure, leg temperatures and power for 500 hours. The experiment starts at 40 °C. The only external inputs are the scenario's clock-based actuator demands. Feedback controllers use the simulated plant state. No station readings enter initialization, the controls, or the state integration. [Native experiment](run_native.py) · [Scenario](native-scenario.json)

## Results

| Measured startup | Post-origin readings per channel | Pressure RMSE, native / constant (MPa) | Coolant temperature RMSE, native / constant (°C) |
| --- | ---: | ---: | ---: |
| Ōi Unit 3, cold shutdown to rated operation | 13 daily | 4.667 / 11.776 | 94.09 / 213.07 |
| Independent Westinghouse pre-generation heatup | 60 hourly | 8.668 / 7.514 | 103.66 / 144.09 |

The generic model ran ahead of Ōi. At hour 48 the station reported 42.0 °C following an earlier heatup, while the native plant predicted 300.55 °C. Grid connection came at hour 33 in the simulation and hour 210 at the station. The native run entered its sustained full-power envelope at hour 55 and 5 minutes. Ōi began constant rated thermal operation at hour 300. At the last daily observation, hour 312, predicted pressure was 0.021 MPa below the station value and predicted coolant temperature was 6.82 °C above it. The endpoint agreement conceals much larger errors earlier in the event.

On the separate Westinghouse heatup, carrying the initial pressure forward produced a smaller error than the native prediction. The native run produced about 1,000 MWe by hour 60, when the source still reported zero reactor power. The generic schedule misses important plant-specific timing. [Interactive comparison](https://ajayasai.github.io/OpenPWR/startup-evidence.html#open-loop) · [Every measured and predicted value](result.json) · [Prediction published before scoring](https://github.com/ajayasai/OpenPWR/blob/0a53e39f6593341658170a94aa9dafbc36ce7c4c/validation/open_loop_startup/native.json)

The largest change on halving the communication step over 6,001 output times was 0.001477 MPa for pressure and 0.006278 °C for mean coolant temperature. The fine run stayed within the native validity domain for 360,000 communication steps. Its maximum stored-energy and stored-mass balance errors at retained times were 0.00244 MJ and 0.000734 kg (rounded up). The full report includes both numerical runs and the source and executable fingerprints. [Native trajectory and checks](native.json)

## What the measurements cover

**Ōi Unit 3.** Kansai Electric published daily operating records for the same reactor during its 2012 restart. The 14 observations span cold shutdown, heatup, synchronization, power ascension and rated thermal operation. Each observation is at 13:00 Japan Standard Time. The model's time zero is June 26 at 13:00, and July 9 at 13:00 is hour 312. Every post-origin reading contributes to the score. The intervals between readings and the native extension from hour 312 to 500 have no paired measurements in this test. [Station reports and extraction](ohi/) · [Operator's restart account](https://www.kepco.co.jp/corporate/profile/community/wakasa/ew/sp/tanpou_s_201207_1.html) · [Registered clock and metrics](ohi-protocol.json)

The station reports primary coolant temperature. OpenPWR uses the arithmetic mean of its hot and cold legs as a proxy. The instrument's averaging weights are unspecified. The primary comparison adds 0.101325 MPa to station pressure under the gauge-pressure convention. The results also give the RMSE if the reported value is interpreted as absolute. The operator reports gross electrical MW for a 1,180 MWe unit. The simulator reports net MW for a 1,000 MWe design. Both are shown with their own ratings. The pressure and temperature comparisons use physical units directly.

**Westinghouse PWR.** EPRI published hot- and cold-leg temperatures and primary gauge pressure for an unnamed plant's measured heatup. We extracted 61 hourly pairs on the original figure clock, converted both temperatures to their arithmetic mean in °C, and converted pressure from psig to absolute MPa. The record ends before the station produced power. It comes from a separate event to the C-E data used in v0.18. [Figure and extraction method](measured/) · [EPRI MRP-393, Figure 2-1](https://restservice.epri.com/publicdownload/000000003002003085/0/Product#page=19) · [Registered test](protocol.json)

## How the prediction was tested

The challenges share a single numerical forecast. Each comparison starts on its published clock and uses exact matches on the native five-minute reporting grid. Each benchmark scores every post-origin reading against both the native forecast and a baseline that carries its own station's first value forward. The baseline receives that one observation. The native simulation receives zero. Signed errors are model minus observed. The results include the origin residual separately, the sample counts, RMSE, mean absolute error, bias, maximum absolute error, and every scored point. A lower RMSE than a constant baseline is a relative comparison. No plant-specific accuracy tolerance was established.

We registered the heatup test and then the additional whole-event test, froze the generic control schedule and code, rebuilt the native executable in a clean checkout, and published the numerical prediction before scoring either measurement file. Source researchers separately transcribed the historical records. The SHA-256 digests and Git revisions connect the measurement files, code, protocols and predictions to the published results. [Registered protocols](https://github.com/ajayasai/OpenPWR/tree/dddd86e/validation/open_loop_startup) · [Frozen model candidate](https://github.com/ajayasai/OpenPWR/tree/63b5668/validation/open_loop_startup)

## Reproduce

From a source checkout with Python 3, recompute the published comparison.

```sh
python validation/open_loop_startup/compare.py --check
```

To repeat the simulation, use the project's Linux or Ubuntu WSL engineering environment. On Linux, after `npm run engineering:setup`, the following rebuilds the continuous model, runs both numerical resolutions, and compares the fresh FMU output with the frozen prediction. The repeat checks bind the binaries and evidence to a clean source revision.

```sh
npm run engineering:continuous:build
npm run engineering:open-loop
python3 validation/open_loop_startup/compare.py --repeat artifacts/open-loop-startup-native.json
```

Each independent integration uses a single instance for the full 500 hours. The solver uses 10-second and 5-second communication steps, with outputs on a common five-minute grid. The finer integration supplies all station comparisons. The runner checks cold initialization, native validity, conservation, full-power dwell and refinement. The additional cross-build check compares every retained pressure, both leg temperatures, bulk temperature, neutron fraction, reactor thermal output, net generation and grid state. [Engineering setup](../../docs/ENGINEERING.md) · [Numerical verification](verify_repeat.py)
