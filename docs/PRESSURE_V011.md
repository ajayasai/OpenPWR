# Shared pressure model development

Version 0.11 adds a finite-phase pressurizer to the thermal equations shared by
native cold startup and continuous startup. It separates liquid and headspace
temperatures, conserves liquid, steam and nitrogen inventories, and includes
radial and axial vessel-wall heat storage. The experimental closure is selected
at Modelica compilation with `useFinitePhasePressurizer=true`; the existing
equilibrium closure remains the interactive default pending the complete
promotion criteria.

The [live comparison](https://ajayasai.github.io/OpenPWR/plant-evidence.html?case=pressure#measured-channel)
shows predictions, measurements and the immutable released v0.10 baseline.
The full JSON retains equilibrium, candidate, no-wall and refined-wall cases,
communication-step refinements, independent boundary accounting and every
pressure and temperature discrepancy. This is development on an already
observed event, not a new independent plant validation.

## Equations and closure

The rigid pressurizer has four fluid states: total pressure, liquid volume,
liquid temperature and common steam/nitrogen temperature. Nitrogen mass is a
separate state. Its partial pressure is `m_N R_N T_v / V_v`; steam properties
use the remaining partial pressure. IF97 region 1 describes the liquid and
region 2 the steam within explicitly checked domains. Nitrogen uses an ideal
gas approximation. Dissolution and noncondensable diffusion resistance remain
unresolved.

Finite-rate transfer permits up to 2 K of liquid superheat or vapor subcooling
relative to steam-partial-pressure saturation before the model stops. Fixed
IF97 phase branches in that narrow band are an intentional model continuation;
the stable-phase property checks do not validate metastable property accuracy.

Each phase has its own mass and energy balance. Interface work is `p dV` with
opposite signs in the two energy equations. Bulk and wall phase transfer carry
the corresponding saturation enthalpy; spray condensation carries the donor
vapor enthalpy. The two phase balances sum to the whole
fluid balance. The primary hot and cold legs and both pressurizer phases are
solved together, retaining sign-dependent upstream enthalpies for surge and
reverse circulation. Separate temperatures preserve compression heating that
instantaneous thermal equilibrium suppresses.

Bulk evaporation and condensation relax thermal superheat/subcooling over a
declared, unfitted 0.1 s time scale. The closure uses temperature departure from
steam-partial-pressure saturation. Comparing liquid enthalpy at total pressure
with saturation enthalpy at steam partial pressure would create spurious
evaporation in an initially isothermal nitrogen-covered cold vessel.

Cold-heating tests exposed a numerical Jacobian problem: perturbing large
absolute states obscured tiny phase-pressure differences. The final model
integrates changes from the five initial fluid-state values and reconstructs
the absolute physical observations. This exact change of coordinates restores
fast default-solver integration without changing the physical equations. A
small phase-law smoothing proposal was tested and rejected; the original
`max(0, x)` phase law remains. The amendment records retain that development
history and the historical failed-pressure snapshot. No measured response was
used to select a phase coefficient or numerical acceptance tolerance.

The wall uses conservative finite-volume heat balances with cylindrical radial
conductances and axial conduction. Graded radial cells resolve the thin inner
thermal layer. A classical Nusselt gravity-film correlation transfers latent
heat into the wall; associated condensation transfers steam mass to the liquid.
Sensible liquid and vapor convection are separate declared assumptions. Stored
energy includes every wall cell. External wall heat loss, when present, belongs
to the external boundary, while liquid/wall and steam/wall exchange cancel
internally. Nitrogen vent energy uses the headspace temperature.

## Inputs and the limits of the comparison

The first frozen candidate passed all 76 numerical checks but **worsened**
primary-pressure RMSE from 0.357371 to 0.679390 MPa. Separate phase temperatures
capture compression, but the wall analogue alone does not reproduce the plant's
pressure-limiting response. Hot- and cold-leg temperature errors also increased.
The original failed candidate, its acquired-sample scores and all 18 paired
guards remain available; adding an actuator does not turn that result into a
pass.

The original Krško measured power, steam-flow and feedwater-flow histories,
initial Table 2 conditions and assumed generic volumes remain unchanged.
Pressure and temperatures are predicted. The eight acquired samples at 1–15 s
are scored; the interpolated t=0 value is used only to expose initialization
bias. No pressure-derived spray history is introduced.

The wall height, thickness, conductivity and volumetric heat capacity come
from a published **Doel-4 input model**, transferred as an explicitly declared
analogue. They are not measured Krško construction data. The assumed Krško
volume is preserved when deriving an equivalent cylinder; end heads are
omitted. The [source audit](PRESSURE_V011_SOURCES.md) records exact pages,
figures, input-deck entries and PDF digests. Spray actuation is reported for
Krško, but its numerical flow history and controller gains are unavailable.
That missing boundary information remains a limitation.

A separately frozen conditional experiment adds native spray recirculation.
Spray removes cold-leg water and its enthalpy and supplies the pressurizer;
direct-contact steam condensation transfers the corresponding energy into the
liquid. Total mass and energy remain closed. The generic controller uses a
15.51 MPa reference from the Krško model documentation, the existing generic
pressure gain of 2 fraction/MPa, and a 20.67 kg/s cap adopted from a **calculated
Doel spray-flow value**. None is a reconstructed measured Krško spray history.
The cap is an analogue assumption, not an identified maximum Krško capacity.
Ideal contact efficiency is nominal; gain 1, gain 4, contact efficiency 0.5 and
a refined wall mesh are retained sensitivities. The nominal choice is fixed
before these runs, not selected from the lowest error.

The completed development comparison did **not** improve accuracy against the
released model. Local results on the same eight acquired samples are:

| Model | Primary pressure RMSE (MPa) | Hot-leg RMSE (K) | Cold-leg RMSE (K) | Secondary pressure RMSE (MPa) |
| --- | ---: | ---: | ---: | ---: |
| Released equilibrium baseline | 0.357371 | 0.913612 | 1.244698 | 0.178408 |
| Finite phase, wall, no spray | 0.679391 | 1.399278 | 1.390429 | 0.177715 |
| Preselected conditional spray | 0.425981 | 1.284295 | 1.372618 | 0.177326 |

Changing spray gain to 1 or 4 gives pressure RMSE 0.467004 or 0.403160 MPa;
halving contact efficiency gives 0.541097 MPa. Every case remains worse than the
released pressure result. The nominal spray case passes only 4 of 18 paired
accuracy/non-degradation guards. Its 88 numerical checks pass, as do the 76
original-case checks, 67 component checks and 16 historical reproduction checks.
Numerical success therefore does not imply better measured prediction. The
equilibrium default remains in place, and neither experimental candidate is
promoted as an accuracy improvement. Clean CI artifacts record their own exact
scores and compiler identity; small solver/compiler differences may affect the
last digits shown here.

The [conditional spray view](https://ajayasai.github.io/OpenPWR/plant-evidence.html?case=pressure-spray#measured-channel)
shows this additional hypothesis separately. Agreement under these unmeasured
control assumptions cannot validate the actual plant controller or justify
silently changing the default model. Manual spray flow is also available in the
native cold and continuous workbenches as an internal recirculation control.

The [frozen protocol](../validation/krsko_pressure/protocol-initial.json) and
[candidate configuration](../validation/krsko_pressure/candidate-config.json)
precede candidate scoring. Pressure RMSE, change RMSE and maximum error must
improve against both the historical release and current equilibrium ablation
beyond communication-step differences. Other temperature and pressure channels
must not deteriorate beyond their numerical allowances. These are development
guards, not instrument uncertainty bands. A failed guard remains failed and
prevents default promotion.

## Reproduction

```sh
npm run engineering:setup
npm run engineering:pressure:verify
npm run engineering:pressure -- --build
npm run engineering:cold:build
npm run engineering:continuous:build
npm run engineering:cold:verify
npm run engineering:continuous:verify
```

The new component, its Modelica composition, reference data, frozen protocols,
runner, independent scoring and publication checks are open source. The
comparison publishes executable hashes and source digests, so a curve cannot
silently be attributed to a different model revision. Numerical verification
and this hot-state transient do not validate the complete cold-to-grid startup.
