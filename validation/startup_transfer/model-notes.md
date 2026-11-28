# Forecasting from startup observations

The forecast starts at the latest available pressure or mean coolant-temperature reading. After two readings of the same quantity, it estimates the rate of change from their difference divided by their elapsed time. It lets that rate decay toward zero as the forecast lead grows. This models the declining value of a recent trend during an unobserved interval. The memory time is an empirical forecast parameter.

Let `y0` be the latest reading, `b` the estimated rate, `h` the lead and `tau` the memory time. Integrating the exponentially decaying slope gives

```text
prediction = y0 + b × tau × (1 − exp(−h / tau))
```

At zero memory the prediction equals the last reading. With positive memory the total extrapolated change is bounded by the magnitude of the initial rate times the memory. Pressure uses MPa absolute, temperature uses °C, and times use seconds on one clock. Each channel has its own observation history. A gap in one instrument contributes no synthetic readings to another.

### Connection to the native model

With just one reading, the recent instrument slope is unknown. The forecast uses a prior rate taken from the [frozen native model run](../shippingport_development/native.json). For each instrument this is the difference between the two native predictions exactly one hour apart starting at that instrument's first observed time, divided by 3,600 s. It is −0.756 MPa/h for pressure and +7.250 °C/h for mean coolant temperature. An independent event uses the same initial rates. Once a second reading is available, the forecast uses the instrument's own recent rate.

The forecast therefore requires observed plant state. Its scores assess the combined observation and initialization method. Separate tests are needed for the native thermal-hydraulic equations, instrument accuracy and prediction from initial conditions alone. The held values must stay out of history for the full forecast interval. A newly available reading at a later forecast origin may initialize the next forecast.

### Development data and fitted memory

Only Shippingport's 1958 initialization and development observations entered the fit. The fitting command calls the existing [development-only export](../shippingport_development/assess.py) and checks the native trajectory fingerprint. The pooled median acquisition interval of the exported instruments is 900 s. The predefined memory grid includes zero, one quarter, one half, one, two and four such intervals. The longest memory allows one hour of unconfirmed trend at the full initial rate in the limit of long lead. The data determine the choice within that range.

For each channel and each grid value, the fitter forecasts each successive development reading from all strictly earlier permitted readings. It minimizes the unweighted mean squared error over these predictions. A tie selects the smaller memory time. These training scores guide parameter selection. Their error estimates reuse the same data that informed the previously frozen Shippingport native case.

Both channels selected 3,600 s, the upper edge of the declared grid. Pressure used 42 development forecasts and coolant temperature used six. The [fitted parameters](parameters.json) include every candidate's development RMSE, both initial rates and the fingerprints of the inputs. The reported test results use the chosen memory; later target readings and their measured startup cannot influence it.

### Run a forecast

From the repository root, run `python validation/startup_transfer/model.py --check` to repeat the fit and verify the parameters. For a new forecast, save a JSON file with the channel, observations ordered from oldest to newest, and the requested time. This synthetic example describes two temperature observations made 900 s apart.

```json
{"channel":"averageCoolantTemperature","history":[[0,95],[900,96]],"targetElapsedS":1800}
```

Run `python validation/startup_transfer/model.py --forecast readings.json`. The command returns the forecast, units and last-reading comparator at that origin. The supported channels are `averageCoolantTemperature` and `primaryPressure`. Every supplied observation must precede the target. Do not append model predictions to the history of instrument readings.
