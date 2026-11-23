# Released native startup output

`model.json` contains the 901 electrical output observations from the nominal
`full-startup` scenario in OpenPWR v0.11.0. It retains every 30-second sample
from 0 to 27,000 seconds, as recorded during a single simulation with a
0.5-second communication step. The source report includes the complete control
schedule, original numerical verification and other scenarios.
[Released report](https://github.com/ajayasai/OpenPWR/releases/download/v0.11.0/continuous-verification.json)

`elapsedSeconds` is time since the generic cold initial state. The reported
`grossPowerMW` is generator electrical output. `netPowerMW` includes the
station auxiliary load, so net output can be negative before power export.
The model's nominal target is 1,000 MW net electric. The report records the
breaker closing at 20,000 seconds. The retained power values are instantaneous
samples. The simulator output uses no civil time, time-zone conversion, or
alignment to a particular station.
[Native model equations](../../models/ContinuousPlant.mo)

To reproduce the export from the published asset, run the command below from
the repository root. To use a local release asset, substitute
`--report PATH` for `--download`. Omit `--check` to regenerate the file.
The extractor checks the size and SHA-256 of the entire original report before
projecting its electrical observations.

The same command also generates or checks `replay.json`, the projection used
by the [startup workbench](../../continuous.html). Its first column gives
elapsed seconds. The remaining columns retain native output values used by
the instruments, cycle diagram and trends. The player verifies the file digest
before playback and displays the most recent recorded sample when seeking.
The original full-precision output values, sampling interval and all 901 rows
are retained in both projections.

```sh
python validation/startup_output/extract.py --download --check
```

When interpreting a grid return to service, identify the meter location,
number of generating units included, interval duration, timestamp convention,
and reporting denominator. A net nameplate target and a unit's observed peak
can give different percentages. Averaging model output over the same interval
can describe what the ramp would look like at the grid series' time
resolution. A subinterval ramp duration cannot be inferred from one interval
average. An electrical record alone leaves the plant's shutdown condition,
time of criticality and control schedule unresolved.
