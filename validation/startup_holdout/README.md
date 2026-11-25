# Shippingport startup, June 24–25, 1958

**The released OpenPWR startup trajectory does not reproduce the measured Shippingport heatup.** During the part of the event covered by both records, the generic model generally pressurizes and heats the primary coolant much earlier. Its pressurizer temperature is lower at the two comparable early observations. This is evidence against using the generic schedule to predict this event. Differences in plant design, initial conditions, equipment availability and operating schedule limit attribution to any one equation. [Interactive results](https://ajayasai.github.io/OpenPWR/startup-evidence.html#shippingport) · [Machine-readable results](result.json) · [Original station report](https://digital.library.unt.edu/ark:/67531/metadc1240466/)

## Measured disagreement

The table uses model minus observation. Temperature errors are in °C, which has the same interval size as K. Each distinct eligible reading has equal weight. The times between readings vary.

| Response | Scored | Beyond model end | Source-flagged | Mean error | Mean absolute error | RMSE | Maximum absolute error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reactor pressure, MPa absolute | 25 | 28 | 1 | +8.87 | 9.22 | 10.58 | 13.94 |
| Average primary coolant temperature, °C | 3 | 13 | 0 | +98.06 | 125.26 | 139.20 | 180.87 |
| Pressurizer temperature, °C | 2 | 15 | 0 | −35.32 | 35.32 | 38.26 | 50.02 |
| Loop 1A cold-leg temperature, °C | 0 | 9 | 0 | — | — | — | — |

At 17:19 on June 24, 4 h 19 min after the first logged event, the station reported 205 °F (96.1 °C) average coolant temperature and 270 psig (1.96 MPa absolute using standard atmosphere). At the same elapsed time the released model gave 250.2 °C and 15.49 MPa. The temperature mapping uses the arithmetic mean of the model's hot and cold legs. The station's precise averaging method and instrument uncertainties are unknown.

The source contains 96 transcribed numerical observations across these four channels. Thirty fall within the model clock and are eligible for scoring. Sixty-five fall after the model run ends. One pressure value is excluded because the station report identifies a probable logging error. An additional 12 cells with unresolved digits are recorded separately. Two AI-assisted readings of the same scan were reconciled against the original pages. [Raw values, times, units and source page for each reading](shippingport/observations.json) · [Source and review](shippingport/README.md)

## What was tested

The prediction came from the complete native `ContinuousPlant` FMU in OpenPWR v0.15.0, released before this comparison. One instance ran the published `full-startup` schedule for 27,000 seconds, producing 901 records at 30-second intervals. The historical observations supplied no forcing or parameter adjustments. The release report, executable fingerprint and scoring protocol were fixed before the measurements were scored. CI re-executes the whole model and checks that its thermal channels and discrete states reproduce the frozen prediction on the entire time grid. [Frozen protocol](https://github.com/ajayasai/OpenPWR/tree/b53d17d39aaf42b75a4b71cd542049b61ad7ff20/validation/startup_holdout) · [Original native report](https://github.com/ajayasai/OpenPWR/releases/download/v0.15.0/continuous-verification.json)

The historical origin is the first clocked station event at 13:00, June 24. The experiment retained the overnight interruption. The comparison uses linear interpolation of continuous **model** outputs at station reading times within the native run. Unobserved periods remain empty. The station reported turbine synchronism after **28 h 59 min**, with the generator breaker still open. The native model's first retained open-breaker synchronizing permissive is at **5 h 05 min 30 s**. Those markers have different definitions, so this comparison assigns no timing error between them.

The station report identifies a missing continuous reactor-power history. Its startup ended with the generator breaker open and supplies no measurement of subsequent loading to full electrical power. The generic model begins with its own cold inventories and supplies its own heat and controls. Shippingport had reached a net capacity of about 60 MWe in its original configuration, while OpenPWR represents a generic 1,000 MWe unit. A validated plant-specific simulation would require matched initial and boundary conditions, independently held-out responses and acceptance criteria justified for the intended use. [Station report](https://digital.library.unt.edu/ark:/67531/metadc1240466/) · [U.S. Department of Energy historical account](https://www.energy.gov/sites/default/files/2018/04/f50/DuncanRickoverandtheNuclearNavyComplete_1.pdf)

## Reproduce

From the repository root, run `npm run validation:shippingport` to check the scores, all time matches and the complete published JSON against the frozen prediction and transcribed data. To verify the prediction independently, download the v0.15.0 report linked above and run `node scripts/shippingport-startup.mjs --verify-archive <downloaded-file>`. It checks the original release digest and reconstructs every retained value. After the native verification workflow has produced a new report for the current clean commit, run `node scripts/shippingport-startup.mjs --repeat artifacts/continuous-verification.json`. The comparison introduces no native model changes.
