# Two-temperature pressurizer research model

`OpenPWR.DynamicPressurizer` adds separate liquid and steam thermal inventories to the native Modelica library. `PrimaryLoop(useDynamicPressurizer=true)` couples it to the existing two primary coolant volumes. The public generic `PrimaryLoop` and `CoupledPlant` FMUs retain the equilibrium pressurizer by default. The choice is structural: changing it requires a separate compiled FMU, not a runtime control toggle.

`OpenPWR.KrskoTransient` selects the new formulation; `OpenPWR.KrskoEquilibrium` uses the same boundary inputs, geometry assumptions and pump heat with the equilibrium formulation for comparison. `OpenPWR.PactelPressurizer` provides a separate-effects experimental case. Adding these models does not establish plant-specific accuracy or full-scope capability.

## Conserved inventories and property domain

The four fluid states are common pressure `p`, liquid volume `Vl`, liquid temperature `Tl`, and vapor temperature `Tv`. The rigid vessel has fixed total volume `V`. Each bulk phase is homogeneous; pressure is common, while its temperature and energy can differ from those of the other phase:

```text
Ml = Vl rho_l(p,Tl)                 Mv = (V−Vl) rho_v(p,Tv)
Ul = Ml h_l(p,Tl) − p Vl           Uv = Mv h_v(p,Tv) − p (V−Vl)
```

The implementation uses the direct Gibbs functions in Modelica Standard Library 4.0.0 `WaterIF97_R1pT` and `WaterIF97_R2pT`. These implement the liquid and steam branches of [IAPWS-IF97](https://iapws.org/technical-guidance/release/IF97-Rev); the [MSL region-1 package](https://build.openmodelica.org/Documentation/Modelica.Media.Water.WaterIF97_R1pT.html) identifies the liquid formulation. The original OpenPWR code remains Apache-2.0 and the MSL retains its BSD license.

The differentials used for each phase are:

```text
rho_p = rho kappa                 rho_T = −rho alpha
u_p = (p kappa − T alpha)/rho      u_T = cp − p alpha/rho
dM = V rho kappa dp − V rho alpha dT + rho dV
dU = V (rho kappa u + p kappa − T alpha) dp
   + V (rho cp − rho alpha u − p alpha) dT + rho u dV
```

For vapor, `dV = −dVl`. Liquid boundary work is `−p dVl/dt` and vapor boundary work is `+p dVl/dt`; these cancel in the whole rigid-vessel balance. The four mass/energy equations form a linear system for the four state derivatives. Pressure columns and energy rows are scaled numerically; scaling does not change the equations. The primary coupling includes the same upstream-enthalpy rule for reversing surge flow as the original model.

The new component stops outside pressure 1–19 MPa, liquid volume 1–99% of vessel volume, liquid temperature 373.15–623.15 K, or vapor temperature below the allowed near-saturation band or above 800 K. Above 16.5291643 MPa, vapor must be on the region-2 side of the IF97 B23 boundary. It does not silently continue into region 3. The primary model adds its existing, tighter primary-system restrictions.

The finite phase-transfer closure below permits liquid up to 2 K above saturation and vapor down to 2 K below saturation on their respective mathematical branches. This narrowly bounded continuation is an **unvalidated constitutive approximation**, not a general nonequilibrium-water equation of state or an extension of IF97's stable-phase accuracy claims. A failed `valid` flag is a domain stop, not an extrapolated physical prediction.

## Mass and energy exchange

Positive surge brings the specified inlet enthalpy into the liquid pool; negative surge removes liquid with the pool's current enthalpy. Spray is a separate liquid input to the pool. Its droplet area, residence time and direct steam condensation are not resolved.

Let `e`, `c`, and `cw` denote bulk evaporation, bulk condensation, and wall condensation. All are nonnegative. With `S` the signed surge, `Fsp` the spray, and `hl,s`/`hv,s` the saturation enthalpies at `p`, the balances are:

```text
dMl/dt = S + Fsp − e + c + cw
dMv/dt = e − c − cw
Hphase = e hv,s − c hl,s
dUl/dt = Hsurge + Fsp hsp + Qheater − Qspecified_loss
       + Qv_to_l − Ql_to_wall − Hphase + cw hl,s − p dVl/dt
dUv/dt = Hphase − Qv_to_l − Qv_to_wall − cw hv + p dVl/dt
```

Wall condensation removes `cw hv` from vapor, supplies `cw hl,s` to liquid, and supplies `cw (hv−hl,s)` to the wall. Thus phase transfer conserves the combined fluid/wall energy. Bulk transfer uses the same transported enthalpy with opposite signs in the two fluid balances.

The finite bulk closure is:

```text
e = Ml max(hl−hl,s,0)/(hfg tau)
c = Mv max(hv,s−hv,0)/(hfg tau)
hfg = hv,s−hl,s
Qv_to_l = Gvl (Tv−Tl)
```

`tau = 0.1 s` is an unfitted relaxation assumption, not a measured plant time constant. It transfers phase mass when a bulk state enters the narrow continuation band. `Gvl = 0 W/K` is the declared insulated bulk-interface assumption. This is motivated by the piston-like surface-layer interpretation of an insurge, but it does not model that layer spatially. Separate pressure/phase-energy states are also used in the [ThermoSysPro dynamic-drum formulation](https://thermosyspro.gitlab.io/documentation/src/WaterSteam/Volumes/DynamicDrum.html); OpenPWR uses its own conservative implementation and does not incorporate that library's code.

## Steel wall and condensation closure

The generic optional wall has 12 fixed axial cells and four finite-volume radial shells by default. The PACTEL benchmark selects 48 axial cells and eight radial shells, based on numerical mesh comparisons before measured-response scoring. Cell masses use actual cylindrical shell volume times a fixed reference density. Temperature-dependent heat capacity multiplies each wall-temperature derivative; stored wall energy uses the exact integral of that same heat capacity. Conductive flux uses the Kirchhoff potential `K(T)=integral k(T)dT`: neighboring radial cells exchange `2 pi L [K(Ti)−K(Tj)]/ln(rj/ri)` and axial cells exchange the corresponding potential difference times ring area over axial distance. These pairwise exchanges cancel exactly in the combined wall balance. Wall cells stay fixed as the liquid interface moves; changing wetted area does not transfer artificial wall mass or stored energy.

Inner and outer surface temperatures are separate algebraic unknowns. Fluid-side transfer and exterior convection are balanced against conduction through the appropriate cylindrical half-cell resistance. The earlier cell-center-as-surface approximation is available only as the explicit `resolveWallFaces=false` ablation. `PactelCoarse` (12×4), `PactelRadialRefined` (12×8), `PactelSpatialRefined` (24×8) and nominal `PactelPressurizer` (48×8) keep all physics and inputs fixed. Their discrepancies are numerical mesh evidence, not parameter fitting or a physical accuracy claim. Wall end caps, flange masses, heater sheaths and liquid thermal stratification remain absent.

Condensation on exposed wall uses the classical gravity-film expression:

```text
Hfilm = 0.943 [g rho_f (rho_f−rho_v,s) k_f^3 hfg /
              (mu_f L_v max(0.1 K,Tsat−Tw))]^(1/4)
Qfilm = Hfilm A_exposed max(Tsat−Tw,0)
cw = Qfilm/(hv−hl,s)
```

Film liquid properties are evaluated near the mean of saturation and inner-wall temperatures. A 273.15 K lower bound protects property evaluation during nonlinear solver trial iterates; it is inactive for accepted temperatures inside the declared wall domain. The 0.1 K denominator regularization gives finite coefficients at zero temperature difference; heat flux still vanishes there. Vapor height, bounded below by 0.01 m, supplies the film length. The formula and its classical assumptions are documented in the [ht library's Nusselt correlation reference](https://ht.readthedocs.io/en/latest/ht.condensation.html#ht.condensation.Nusselt_laminar). No correlation multiplier is fitted to either measured pressure curve. Curvature, waves, entrainment, noncondensables and an explicit superheated-vapor boundary layer are omitted.

Liquid-to-wall convection uses an assumed 500 W/(m² K). A 10 W/(m² K) vapor convection term allows heating by a wall hotter than the bulk vapor. These are disclosed closure assumptions, not identified facility coefficients. The film term handles cooling/condensation at a wall below saturation. Exterior loss is the specified exterior coefficient times exterior area and wall-to-ambient temperature difference.

`thermalEnergyMJ` for the standalone component includes both fluid inventories and all modeled wall cells. Its external energy boundary is surge enthalpy plus spray enthalpy plus heater power, less imposed fluid loss and exterior wall loss. Integrated boundary outputs permit independent inventory-change checks; small instantaneous residuals alone are insufficient.

## Case inputs and provenance

The PACTEL case uses [NRC NUREG/IA-0231](https://www.nrc.gov/regulations-legislation/nureg-series-publications/publications-resulting-from-international-agreements/ia0231): ideal cylinder height 8.8 m, inner radius 0.06985 m, 14.3 mm wall, initial pressure 5.9 MPa, liquid level 3.3 m, fluid temperatures 547.64 K and wall temperature 547 K. The appendix supplies the inlet-temperature, flow and heater schedules, exterior coefficient 3.44 W/(m² K), and ambient temperature 298 K. These are published TRACE boundary approximations, not a complete measured inlet record. The report identifies wall condensation and liquid stratification as important and reports shortcomings even for the much more detailed reference calculation.

The wall drawing identifies AISI 304. The v0.6 implementation used room-temperature constants from an [Outokumpu datasheet](https://www.outokumpu.com/-/media/files/products/core/outokumpu-core-range-datasheet.pdf). The current PACTEL model uses the independently published AISI 304 relations in [NISTIR 7401, section 3.1.1 and Figure 1, printed page 7](https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=860705):

```text
cp(T) = 6.683 + 0.04906 T + 80.74 ln(T)           J/(kg K)
k(T)  = 9.705 + 0.0176 T − 1.60e−6 T²           W/(m K)
rho_reference = 7920 kg/m³ at 296.15 K
```

Temperature is in kelvin. The implementation restricts these wall functions to 273.15–1073.15 K. Thermal expansion is omitted: reference density determines fixed wall-cell masses and geometry. This material choice was fixed from the published properties before the new pressure comparison; no coefficient is fitted to PACTEL. It does not reproduce TRACE's material functions or identify the actual test vessel's property uncertainty. The original constant-property path remains available for other materials through `useTemperatureDependentSteel=false`. The ideal cylinder contains 134.885 litres, while the independent [VTT facility description](https://publications.vtt.fi/pdf/tiedotteet/1998/T1929.pdf), Table A.3, lists 133.5 litres. The selected published benchmark geometry is preserved and its approximation disclosed.

For Krško, all four pressurizer controls are explicit inputs; unidentified histories default to zero. Published CVCS volumetric flows are not silently converted to kg/s without instrument reference conditions. The 6 MW pump-heat contribution documented for the 2005 plant is deposited directly in cold coolant and included in the energy boundary, separately from fuel heat. Its initial secondary heat-transfer calibration includes that contribution. Primary volumes, their hot/cold allocation, pressurizer volume, fuel capacity and secondary inventory remain explicit parameters where no event-applicable geometry was established. The Krško wrapper omits the wall because its geometry and thermal conditions remain unidentified; this is an adiabatic assumption, not an identified plant boundary.

No post-initialization response is used to tune geometry, gains, transfer coefficients, wall properties or time constants. A new formulation can worsen a held-out discrepancy; comparison results must retain that outcome.

## Numerical checks and applicability

The PACTEL runner requests a `1e-9` relative solver tolerance; Krško requests `1e-11` to constrain accumulated conservation error in its much larger inventories. Both values are also compiled into their Modelica experiment annotations. In the tested OpenModelica 1.27.1 co-simulation runtime, the CVODE log retained the compiled tolerance when FMI `setupExperiment` requested a different one. The runner therefore checks the FMU's declared default against the requested tolerance; the runtime logs confirmed `1e-9` for PACTEL and `1e-11` for Krško. A request alone is not evidence that the native integrator changed tolerance.

Measured boundaries are held over each FMI communication step, with all published event knots retained exactly. Independent external-flux quadrature uses the imposed input for both endpoints of each step, avoiding stale algebraic outputs immediately after FMI `setReal`. Time-step refinement and integrated mass/energy errors are reported separately from measured-response errors.

The compiled property check additionally verifies wall enthalpy and conductivity-potential derivatives at 300, 550 and 1000 K, plus their integrals across three temperature intervals. These 18 checks are reported separately from the 24 published water-property comparisons and 40 thermodynamic consistency checks. They verify implementation of the selected material correlations; they are not independent measurements of the test vessel's steel.

Before measured scoring, the development mesh comparison at a common 0.1 s communication step found maximum pressure changes of 0.00720 MPa for 12×4→12×8, 0.07094 MPa for 12×8→24×8, and 0.03352 MPa for 24×8→48×8. All four runs passed independent inventory checks. The finest tested mesh was selected because axial differences decreased with refinement; the selected material and transfer closures were unchanged. These differences do not establish asymptotic convergence or bound the remaining spatial error. The release report repeats the mesh sequence at a common 0.05 s communication step and retains the unresolved spatial error explicitly.

During development, an initial formulation using the approximate IF97 `p,h` backward map failed independent inventory checks near phase transitions despite small equation residuals. The released formulation uses direct `p,T` properties and analytic differentials. That numerical correction is not experimental validation. The measured comparisons, property-domain stops, unknown-parameter sensitivities and any unassessed spatial convergence remain visible in the separate evidence reports.
