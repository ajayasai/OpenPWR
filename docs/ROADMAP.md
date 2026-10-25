# Path toward a full-scope simulator

OpenPWR is an open, reduced-order simulation laboratory. A complete operating envelope, a detailed control-room interface, and independently demonstrated physical fidelity are separate requirements. Adding a startup sequence does not, by itself, establish any of the others.

## Evidence levels

1. **Numerical verification:** conservation, convergence, analytical solutions, deterministic replay, and comparison with published point-kinetics solutions. These test the equations and solver.
2. **Component reference comparisons:** published thermodynamic tables and verification values, followed by component experiments with independently specified inputs and uncertainty. These constrain individual closures.
3. **Coupled plant validation:** measured transient traces, documented plant configuration, initial conditions, controller settings, boundary conditions, instrument uncertainty, and an independent comparison protocol. Passing generic load-following scenarios does not satisfy this level.
4. **Simulator qualification:** an agreed operating envelope, configuration management, comprehensive system and instrumentation models, expert review, and a separately established qualification process. OpenPWR makes no qualification claim.

## Next engineering increments

Version 0.4 extends the separate OpenModelica hot-system workbench with direct pressure/temperature property evaluation, nine subsystem checks, 24 published water-property comparisons, and 25 separately identified derivative-consistency checks. Timed experiments, command replay, and the native evidence viewer make these results reproducible and inspectable. The interactive 3D view depicts simulated observations using illustrative geometry. Measured coupled transients, plant-specific geometry, broader operating conditions and integration with the browser physics model remain future work.

| Increment | Required modeling work | Evidence needed before claiming fidelity |
| --- | --- | --- |
| Primary pressure and inventory | Separate pressurizer liquid/vapor volumes, surge flow, heater/spray energy, charging and letdown mass balances | Published pressure/inventory transients and conservation/refinement studies |
| Cold and hot operation | Pump heat, shutdown cooling, pressure-dependent properties, consistent restart and cooldown across the supported range | Heatup/cooldown reference traces with known equipment and controls; startup in this release remains a generic model experiment |
| Multi-loop thermal hydraulics | Resolved legs and volumes, pump curves, transport delays, buoyancy-driven circulation | Pump coastdown and natural-circulation experiments |
| Steam generators and balance of plant | Vapor inventory, boiling boundaries, shrink/swell, feed heaters, reheater, condenser inventory, turbine maps | Steam-generator and turbine/condenser reference cases |
| Core spatial response | At least axial power and temperature nodes; consistent rod/boron feedback and delayed-neutron parameters | Spatial benchmark input decks and measured or independently computed outputs |
| Instrumentation and controls | Sensor dynamics, indications, protection channels, failure modes, electrical auxiliaries | Traceable logic specifications and independent test cases |
| Extended transient envelope | Additional physical models for each new regime, with deliberate domain stops until implemented | Appropriate experimental or published coupled benchmarks; no extrapolation from normal-operation checks |

## Candidate whole-plant evidence

The [OECD/NEA VVER-1000 coolant-transient benchmark](https://www.oecd-nea.org/jcms/pl_32219/vver-1000-coolant-transient-v1000ct-benchmarks) is a potential later source of coupled-code and plant-data comparisons. It concerns a specified VVER configuration. OpenPWR has neither implemented that benchmark configuration nor reproduced its transients; similar electrical rating alone does not justify a comparison.

The [IAEA PWR simulator workshop material, second edition](https://www-pub.iaea.org/MTCD/Publications/PDF/TCS-22_2nd_web.pdf) describes a broader educational system model and its limitations. It is useful for identifying missing systems, not as proof that this simulator produces matching results. No third-party simulator source code is included here.

For each new benchmark, record the source revision and exact table/figure, input data, units, preprocessing, calibration split, acceptance criterion, result, and remaining discrepancy. Keep failed comparisons visible. Do not tune a model to a reference and then describe that same reference as independent validation.
