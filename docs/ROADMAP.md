# Path toward a full-scope simulator

OpenPWR is an open, reduced-order simulation laboratory. A complete operating envelope, a detailed control-room interface, and independently demonstrated physical fidelity are separate requirements. Adding a startup sequence does not, by itself, establish any of the others.

## Evidence levels

1. **Numerical verification:** conservation, convergence, analytical solutions, deterministic replay, and comparison with published point-kinetics solutions. These test the equations and solver.
2. **Component reference comparisons:** published thermodynamic tables and verification values, followed by component experiments with independently specified inputs and uncertainty. These constrain individual closures.
3. **Coupled plant validation:** measured transient traces, documented plant configuration, initial conditions, controller settings, boundary conditions, instrument uncertainty, and an independent comparison protocol. Passing generic load-following scenarios does not satisfy this level.
4. **Simulator qualification:** an agreed operating envelope, configuration management, comprehensive system and instrumentation models, expert review, and a separately established qualification process. OpenPWR makes no qualification claim.

## Next engineering increments

Version 0.11 adds separate liquid/steam temperatures and wall storage to the
shared startup pressure equations. Its [Krško development comparison](PRESSURE_V011.md)
preserves a released baseline, equilibrium ablation and numerical refinements.
Pressure improvement alone cannot hide deterioration in temperature channels;
the frozen paired guards control default promotion. Actual Krško wall geometry,
spray histories, transport and independent startup measurements remain missing.

Version 0.10 adds direct measured evaluation of the continuous model's shared thermal kernel. It does not turn the older operating-plant transient into startup data. The [source audit](STARTUP_MEASURED_EVIDENCE.md) identifies why available VVER power curves and EPRI startup examples cannot supply complete independent measured startup validation.

Version 0.9 adds one native cold-to-power FMU with source-driven six-group kinetics, delayed heat, rod motion, dynamic shaft energy, phase/frequency/voltage synchronization, and load pickup. Native states evolve continuously from cold initialization; the separate prescribed-heat cold and hot-operation FMUs remain independent experiments. Verification uses published point-kinetics values, independent equation/boundary calculations, synchronization acceptance/rejection and full-trajectory timestep refinement. Measured whole-plant startup fidelity is still unestablished. Pressure work retains immutable v0.7 baselines and labels ATWS-11 as post-unblinding development; the event cannot become blind again. Plant-specific geometry, detailed secondary equipment, multi-loop/spatial response, containment and emergency core cooling remain future work.

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

[Krško NUREG/IA-0221](MEASURED_VALIDATION.md) covers only the early governor-closure thermal response with measured power and flows as imposed inputs. PACTEL ATWS-10 independently tests pressurizer pressure response using the published study's boundary approximations. Neither validates the coupled model's reactor, turbine, protection, condenser or new auxiliary-feedwater predictions. ATWS-10 informed model development; the ATWS-11 compression response was reserved during v0.7 and scored after that release’s source freeze. In v0.8 it is an already-observed development comparison; the original freeze and report remain unchanged. This is a same-facility development separation, not historically blind external certification. Further work needs event-era plant geometry and control histories, resolved liquid stratification, complete uncertainty studies and additional independent cases. If any parameters are fitted, subsequent validation must use a separately held-out event.

The [OECD/NEA VVER-1000 coolant-transient benchmark](https://www.oecd-nea.org/jcms/pl_32219/vver-1000-coolant-transient-v1000ct-benchmarks) is a potential later source of coupled-code and plant-data comparisons. It concerns a specified VVER configuration. OpenPWR has neither implemented that benchmark configuration nor reproduced its transients; similar electrical rating alone does not justify a comparison.

The [IAEA PWR simulator workshop material, second edition](https://www-pub.iaea.org/MTCD/Publications/PDF/TCS-22_2nd_web.pdf) describes a broader educational system model and its limitations. It is useful for identifying missing systems, not as proof that this simulator produces matching results. No third-party simulator source code is included here.

For each new benchmark, record the source revision and exact table/figure, input data, units, preprocessing, calibration split, acceptance criterion, result, and remaining discrepancy. Keep failed comparisons visible. Do not tune a model to a reference and then describe that same reference as independent validation.
