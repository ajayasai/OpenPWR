# Historical thermal boundaries

The case uses the native `ContinuousPlant` fuel, coolant, two-phase water and cover-gas vessel, secondary and whole-plant balances. A heat input adds energy through the existing fuel balance and the integrated plant boundary. Pressure follows water properties, fluid expansion, energy storage, gas inventory and the native volume constraint. The predicted mean coolant temperature is the arithmetic mean of the two native loop temperatures. The run uses a single state history through the overnight interruption.

The historical schedule specifies five **effective** boundary amplitudes. Their magnitudes refer to the generic simulator's inventory. Equipment dimensions, actual equipment power and continuous reactor heat were unavailable. The model starts both primary fluid inventories at the first reported bulk coolant temperature and starts pressure at the first reported absolute pressure. These two readings have different timestamps and initialize the model at the earlier common log origin. The primary loop circulates at one half of the model's rated flow throughout. The aggregate heat accounts for unresolved equipment heating, so the separate circulation heat term is zero in this case. The historical case has no demand for electrical generation.

## Training and reproduction

Only the two target channels' calibration rows enter the amplitude estimator. The model runner reads the frozen [thermal boundaries](thermal-boundaries.json) and never reads observations. The phase times were selected manually using the developmental portions of the event. Their precision expresses the archived minute-clock timing.

| Effective process | Basis for the interval |
| --- | --- |
| First bulk heat and vessel heat inputs | The first bulk temperature reading at 13:18 through the 19:41 June 24 reading. The latter matches the temperature reported the next morning during the recorded interruption. |
| Early gas removal | The first pressure observation at 14:05 through 16:35 on June 24. The latter is the final 200 psig reading of the developed afternoon pressure minimum. A single vent coefficient describes the early gas loss. |
| Resumed bulk heat | Documented resumption at 11:17 on June 25 through the first developed 501 °F point at 15:30. |
| Resumed vessel heat | The same resumption to the first developed near-plateau pressure observation at 14:15. |

During the final reserved block the modeled fluids continue exchanging energy and mass with the aggregate heat additions off. The inputs are retrospective estimates of the net thermal forcing. The estimates and onset/end times are specific to this event.

Run `python validation/shippingport_development/fit.py --workers 5` in the native engineering environment with the compiled historical FMU. The utility prints the fitted values and objective history. It reads [only the development view](assess.py), estimates five amplitudes, and never rewrites the frozen inputs. The fit minimizes the sum of the two channel mean squared errors divided by working scales squared (10 °C and 1 MPa). These scales give the two channels comparable influence and have no interpretation as sensor uncertainties. It uses five finite-difference Gauss–Newton iterations, nonnegative physical bounds and a backtracking step. The initial amplitudes and step-size bounds are in [fit.py](fit.py). Exploratory runs on development observations informed the initial guesses. The solver's fitted coefficients are rounded to five decimal places in the case.

The primary run uses 60-second FMI steps, and every flux transition is an exact step boundary. A second native run uses 30-second communications with comparisons on the same minute grid. The temperature and pressure refinement limits are 0.01 °C and 0.001 MPa. The [generic native verification protocol](../continuous/protocol.json) supplies energy and mass conservation tolerances. The resulting trace includes actual numerical differences, conservation errors, subcooling margin and trip/breaker flags. Each native step must remain inside the declared model domain.
