# Native auxiliary feedwater

The native `CoupledPlant` includes two generic electric auxiliary-feedwater trains and a finite atmospheric water tank. Auxiliary water physically enters the modeled steam generator, adds its actual enthalpy, drains the tank, and consumes electrical power. This adds a missing hot-plant support system; it does not qualify a real plant's safety system or extend the primary model into cold operation.

The system function is supported by the NRC's [auxiliary-feedwater system study](https://nrcoe.inl.gov/SysStudy/AFW): auxiliary feedwater supplies steam generators when main feedwater is unavailable. The NRC also documents [automatic initiation on low steam-generator level](https://www.nrc.gov/documents-reports/generic-communications/generic-letters/1989/gl89019). OpenPWR's numerical capacities, control thresholds and timings below are **declared generic assumptions**, not copied plant specifications. This model omits a turbine-driven third train, diesel/bus dynamics, shared-cause failures, piping transients, suction-line hydraulics, recirculation piping and pump cavitation.

## Equipment and controls

Each train has a continuous speed state, manual demand, independent availability and an isolation-valve input. Speed follows a two-second first-order response. A quadratic pump-head curve supplies only forward flow; its check-valve approximation rejects reverse delivery and flow when developed head cannot overcome steam-generator pressure. Closing an isolation valve blocks that train's delivery while its energized motor can still consume idle power.

Availability is a drive-demand permissive: removing it commands the speed state toward zero through the same lag. It does not represent opening an electrical bus. During that prescribed rundown, the algebraic motor-power calculation continues to supply the modeled hydraulic work and losses. Pump-rotor inertia, physical loss-of-power coastdown and bus energy balances require additional states and are outside this component's scope.

The square-root flow law is regularized only within the lowest 1% of positive normalized head. The transition is `sqrt(delta) * z² * (2.5−1.5z)`, where `delta=0.01` and `z=head/delta`; below zero head delivery is exactly zero, and above the transition the ordinary square root applies. Matching value and slope at both boundaries avoids a singular zero-flow derivative in the generated native solver. This is a declared numerical approximation to check-valve opening, not a measured valve characteristic.

Automatic demand latches on a generic steam-generator level below 40%, or when measured main feedwater falls below 10% of nominal while steam flow remains above 10%. The automatic-enable switch gates that demand; manual commands are independent. Resetting the experiment clears the latch. A generic 85% steam-generator-level cutoff blocks auxiliary delivery. These signals use the aggregate model's liquid-volume indication, not a real narrow-range level instrument or redundant protection voting logic.

The defaults are 60 kg/s per train at nominal steam-generator pressure, a 10 MPa full-speed shutoff pressure rise, 75% hydraulic efficiency, 95% motor efficiency, and 5 kW per train of speed-cubed idle motor loss. The nominal tank contains 100,000 kg of 25°C water. A 1,000 kg suction heel is unavailable for delivery. Reaching that heel latches both trains off; tank mass is never reset or clipped to manufacture water. The `auxTankDepleted` indication means usable inventory is exhausted, not that all tank liquid has vanished.

The native FMI runtime detects the heel crossing on communication boundaries. A small overrun can therefore remain below the nominal heel; the depletion test limits it to one communication step's maximum observed delivery plus 0.01 kg, while independently enforcing whole-plant mass conservation. This preserves the actual integrated state rather than repairing the reading after the event.

## Mass and energy accounting

For tank mass `M`, delivery `q`, atmospheric pressure `p`, specific liquid volume `v`, specific internal energy `u`, and enthalpy `h=u+pv`:

```text
dM/dt = −q
Utank = M u
Wdisplacement = p dV/dt = −p q v
dUtank/dt = −q h − Wdisplacement = −q u
```

Uniform adiabatic withdrawal at fixed atmospheric pressure leaves the remaining liquid temperature unchanged. Its reported temperature is therefore the declared initial temperature, and its stored energy decreases with its finite mass. Tank thermal stratification and environmental heating are not represented. Atmospheric pressure work is included explicitly; ignoring it would violate the open-tank internal-energy balance.

The pump's delivered fluid work is `q (pSG−ptank)/(rho etaHydraulic)`. This increases auxiliary feedwater enthalpy. Electrical draw additionally includes motor inefficiency and the idle term. Those motor losses leave to the unmodeled room; they are not silently added to water enthalpy. Net plant electricity subtracts the full auxiliary motor draw.

Main and auxiliary inlet enthalpies are mixed by mass flow before entering the steam-generator energy balance. The tank belongs inside the reported whole-plant inventory, so auxiliary delivery cannot create whole-plant water. The added whole-plant energy boundary is:

```text
+ auxiliary electrical power − motor loss − tank displacement work
```

The existing `feedwaterFlowKgS` keeps its main-feedwater meaning for compatibility. `mainFeedwaterFlowKgS` is its explicit alias; `totalFeedwaterFlowKgS` includes auxiliary flow. `feedwaterTemperatureC` now reports the mixed inlet. Separate train flows, speeds, tank mass/energy, motor power, fluid power and atmospheric work are observable for audit and model-driven animation.

## Verification and limits

Verification preserves the existing coupled-plant checks and adds independent pump-lag, train-isolation/availability, automatic-initiation, finite-tank, electrical-accounting, communication-step refinement and mass/energy checks. Conservation tests include tank storage and reconstruct external energy from individual observable powers. A low-initial-inventory test exercises depletion without making the public nominal tank artificially small. These are numerical and generic-response checks, not measured plant validation or evidence of sufficient emergency-cooling capability.
