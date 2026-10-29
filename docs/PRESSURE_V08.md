# Pressure-model development after v0.7

The v0.8 pressure work addresses the condensate-film closure in the experimental PACTEL pressurizer. It does not add unidentified wall geometry to Krško, and it does not change the generic hot plant's equilibrium pressurizer. The measured comparisons remain conditional component/early-transient comparisons, not plant validation.

Both PACTEL pressure curves have already been inspected. ATWS-11 was reserved for the v0.7 development cycle, but is **not a new holdout for v0.8**. The original frozen candidate and its reported results remain in the repository and v0.7 release. Current comparisons are explicitly post-unblinding development evaluations. No pressure samples determine a fitted coefficient, time shift, pressure offset, initial condition, geometry, wall property, or boundary schedule.

## Physical change

The previous wall closure applied the mean, smooth-film Nusselt coefficient for the entire exposed vapor height independently to each axial cell. That formulation neither follows the condensate draining down the wall nor determines whether its film Reynolds number is compatible with the assumed flow regime. NUREG/IA-0231 section 4.1 identifies wall condensation as the dominant compression mechanism and discusses underprediction by a wave-free closure. This motivates checking the closure, rather than multiplying its heat transfer by a fitted gain.

The new optional closure uses the film mass flow accumulated from the cells above the current cell, plus half of the current cell's condensation. Cell numbering increases from the vessel bottom to its top. For circumference `P = 2 pi r`, the midpoint film flow per unit width is

```text
Gamma_i = (sum(mcond_j, j > i) + 0.5 mcond_i) / P    kg/(m s)
Re_delta = 4 Gamma_i / mu                           dimensionless
l_f = [mu^2 / (rho_l (rho_l-rho_v) g)]^(1/3)        m
Pr = cp mu / k                                     dimensionless
h_i = (k/l_f) Nu_i                                 W/(m^2 K)
```

The density-difference term retains the vapor's contribution to buoyancy. Water properties are evaluated at the existing wall-film temperature. Condensation power is `h_i A_vapor,i max(Tsat-Twall,i,0)`. The existing conservative exchange remains unchanged: vapor loses its current specific enthalpy with the condensed mass, the liquid receives saturated-liquid enthalpy, and the difference heats the wall. Film storage and transit time are neglected, so the condensate drains into the liquid inventory immediately. The midpoint closure is an algebraic approximation; spatial refinement remains necessary.

The local laminar limit follows directly from the gravity-film momentum balance:

```text
delta = [3 mu Gamma / (rho_l (rho_l-rho_v) g)]^(1/3)
Nu_lam = l_f/delta = (4/(3 Re_delta))^(1/3)
       approximately 1.1 Re_delta^(-1/3)
```

For developed wavy/turbulent condensation the implementation uses the **quiescent-vapor branch** of Chen, Gerner and Tien's correlation:

```text
Nu_wavy = 0.823 Re_delta^(-0.22)
Nu_turb = 0.00402 Re_delta^(0.4) Pr^(0.65)
Nu_chen = (Nu_wavy^6 + Nu_turb^6)^(1/6)
```

The original article is [Chen, Gerner and Tien, *General film condensation correlations*, Experimental Heat Transfer 1(2), 93–107 (1987)](https://doi.org/10.1080/08916158708946334). The numerical quiescent-vapor form and Reynolds-number convention are reproduced in [INL/JOU-22-66089 Revision 1, section 4.2.2, equation 10, printed pages 27–28](https://www.osti.gov/servlets/purl/2337434). In that report `Re_f = Gamma/mu`; its `4 Re_f` is the `Re_delta` used here. No additional factor of four is applied. The 0.00402 condensation coefficient is distinct from the 0.0038 evaporation-film coefficient also discussed by that source.

[Papini and Cammi (2010), section 3.2](https://doi.org/10.1155/2010/815754) discusses local versus mean film coefficients and laminar, wavy and turbulent regimes. These sources justify a mechanistic development candidate; they do not establish that a high-pressure PACTEL transient, with its actual surface condition, exactly obeys the selected correlation.

## Numerical regularization and scope

The low-Reynolds transition is an explicit implementation assumption. A cubic smoothstep blends the laminar and Chen forms between `Re_delta=20` and `40`, around the commonly used transition near 30. Below that interval the laminar form applies, and above it the published Chen blend applies. The coefficient calculation has a floor of `Re_delta=1` to regularize the leading edge and zero-condensation state; the diagnostic output reports the unfloored Reynolds number. At zero temperature difference the condensation heat flow remains zero. These values are not fitted to either pressure curve.

The generic component defaults to `useRegimeCondensation=false`, preserving the old mean-Nusselt option. PACTEL explicitly enables the new option. The old path remains available as a structural ablation. The new closure still assumes pure vapor, negligible interfacial shear, a thin film relative to vessel radius, immediate drainage and no resolved film inventory. It omits curvature, noncondensable gases, wave dynamics, entrainment and the vapor boundary layer. The PACTEL liquid remains a homogeneous pool, despite the experimental report's discussion of stratification. An improved pressure error would not validate those assumptions.

## Development trials and reporting

An initial trial corrected only the spatial averaging of the old laminar coefficient. At the 0.1 s communication step its ATWS-10 RMSE was 0.197534 MPa and ATWS-11 RMSE was 0.216925 MPa, worse than v0.7's respective 0.187120 and 0.201964 MPa. Its independent mass and energy checks passed. The unfavorable result is retained here: correcting a numerical/spatial assumption alone did not improve measured agreement.

An intermediate exploratory trial combined local laminar and wavy correlations with the 0.0038 evaporation-film turbulent coefficient using a maximum. It was stopped before obtaining a complete scored result. The final candidate instead uses the condensation-specific Chen coefficient and continuous sixth-power blend on physical/source grounds. Neither trial adjusts coefficients to measured pressure. The release evidence reports the final candidate's raw discrepancies, time-step refinement, spatial comparisons and unchanged original measured input schedules, alongside immutable v0.7 values. Numerical conservation and a lower measured discrepancy are separate outcomes.

The selected 48-axial/eight-radial-cell candidate produced the following development results at the existing 0.1 s communication step, with the original timing and initial/boundary conditions:

| Comparison | v0.7 | v0.8 candidate | Interpretation |
| --- | ---: | ---: | --- |
| ATWS-10 pressure RMSE, MPa | 0.187120 | 0.168747 | 9.82% lower discrepancy |
| ATWS-10 maximum same-time pressure error, MPa | 0.806404 | 0.705826 | The compression peak is still substantially too high |
| ATWS-11 pressure RMSE, MPa | 0.201964 | 0.182504 | 9.64% lower discrepancy; post-unblinding comparison |
| ATWS-11 maximum same-time pressure error, MPa | 0.713268 | 0.654578 | A material terminal overprediction remains |

The final diagnostic reports the maximum local film Reynolds number over **vapor-exposed wall cells only**, before the zero-flow floor is applied. Fully submerged cells are excluded: although condensate flow can be algebraically continued through them, they are not part of the condensing film. This diagnostic is calculated by the model, not measured independently at the experiment. The prediction still depends on the selected correlation and instantaneous film-drainage assumption.

Both runs passed independent physical-inventory and native-integral checks. The largest independent mass discrepancy was `6.36e-6 kg`, below the `1e-4 kg` numerical criterion; the largest independent energy discrepancy was `8.73e-6 MJ`, below `0.005 MJ`. Those conservation checks establish numerical accounting, not pressure fidelity. The final release report additionally executes the prescribed 0.05 s comparison and three coarser meshes; its complete trace and numerical checks are authoritative for the published build.

The final factored correlation and diagnostic, with the runner avoiding redundant unchanged-input writes, were compared against the same inline correlation using the earlier runner. Maximum pressure differences across the complete traces were `7.13e-7 MPa` (ATWS-10) and `1.27e-7 MPa` (ATWS-11). Separately, both complete pressure traces from the released v0.7 PACTEL FMU were reproduced exactly with the updated runner. The pressure improvement is therefore not explained by the unchanged-input optimization. Krško omits the optional wall and remains outside this closure's improvement claim. Its previously disclosed pressure discrepancy is not corrected by a PACTEL-only wall model.

## Bounded regularization sensitivity

The [development result record](../validation/pactel1998/film-regularization-v0.8.json) retains the exact candidate source, wrapper, binary, runner and script hashes, numerical balances and pressure comparison trace. It evaluates ATWS-10 through 221 s, including the compression peak; it does **not** establish sensitivity for the later outsurge or for ATWS-11. The nominal reference run retains its full 500 s conservation accounting. All 20 conservation checks passed.

| Numerical variation, with other inputs unchanged | Maximum pressure change from the nominal candidate over 0–221 s, MPa |
| --- | ---: |
| Transition interval 10–50 instead of 20–40 | 0.00006923 |
| Transition interval 25–35 instead of 20–40 | 0.00004245 |
| Reynolds floor 0.1 instead of 1 | 0 |
| Reynolds floor 10 instead of 1 | 0.00004541 |

These bounded changes are small compared with the remaining measured pressure discrepancy. They are not uncertainty bounds for the selected condensation correlation. The zero difference for the smaller floor is specific to the tested window and does not justify removing a numerical guard for other regimes.

The recorded development binary precedes the final diagnostic correction that excludes submerged wall cells from `maximumFilmReynolds`. Only that reported maximum changed afterward; the pressure equations and film correlation did not. The record explicitly identifies this snapshot and must not be substituted for the final release manifest or canonical measured report.

After building the native PACTEL FMU, reproduce the study with the Python environment containing FMPy:

```sh
artifacts/engineering-venv/bin/python validation/pactel1998/film_sensitivity.py
```

The runner executes the fixed nominal and four varied cases and writes `artifacts/film-regularization.json`; no optimizer or measured-pressure calibration is involved. Its `--summarize-existing` option validates the binary identity, parameters, observation grid and numerical accounting of explicitly supplied development runs before summarizing them. The canonical release comparator separately retains full time-step and spatial refinement evidence.
