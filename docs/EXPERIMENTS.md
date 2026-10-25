# Experiments in the simulator

These are experiments on a generic mathematical model, not operating instructions for any real facility. Begin with a fresh nominal or half-load state for repeatable comparisons. Record the version, initial state, control changes, and simulation time.

## 1. Where does the electrical power come from?

At the nominal point, compare reactor thermal power, generator output, and net electrical output. Watch fuel, coolant, and steam-generator temperatures. Heat stored in these components prevents instantaneous response when demand changes. The difference between thermal and electrical power is not a solver error: heat is rejected by the conversion cycle and auxiliary equipment consumes power.

## 2. Demand step

Start at full power, leave automatic controls enabled, and lower demand to 75%. Compare the electrical and thermal power trends, steam pressure, average coolant temperature, and reactivity. The demand control changes controller targets; it does not directly overwrite the measured electrical output. Save an initial-state JSON file before the change to repeat the experiment.

Headless equivalent: `npm run simulate -- --scenario=load-step --duration=960`. The step occurs at 60 s and requests 75% load.

## 3. Thermal inertia after a trip

Reset to nominal, then select SCRAM. Fission power falls quickly, but fuel and coolant temperatures cannot change discontinuously. Fission-product heat remains. Compare neutron power and total reactor heat rather than treating them as the same quantity. This model's decay groups are a simplified inventory approximation, not a qualified decay-heat standard.

## 4. Equipment disturbances

Try one fault at a time. The injected flags are reversible, but reactor protection is latched. Restoring a pump or clearing a scenario does not erase the trip. Resetting the whole simulation is a fresh initial condition; it is not a modeled physical restart. A trip-reset button may be inhibited while active faults or unacceptable modeled conditions persist.

## 5. Conservation versus accuracy

Inspect the thermal energy residual in the interface or exported data. A small residual shows that stored-energy changes and the documented boundary heat flows balance numerically. It does not prove that heat-transfer coefficients, inventories, controllers, or plant transients are realistic. Read the boundary definition in MODEL.md.

## 6. Numerical refinement

Run the same headless scenario with `--dt=0.05` and `--dt=0.025`, then compare results at common sample times. Differences should shrink as the integration is refined within the domain. The independent test suite additionally compares the pure kinetics solver with a matrix-exponential reference.

## Files and time

Snapshots preserve model state for deterministic continuation; they do not encode a complete operator action history. CSV exports provide measured history with units documented in the model and accompanying headless JSON. Browser chart/history buffers are bounded. Simulation speed changes the amount of simulated time per wall-clock second, not the physical parameters. Background tabs may be throttled; use the CLI for reproducible long runs.

When a domain limit is reached, the simulation stops and identifies the reason. A stop is the boundary of the mathematical model, not a prediction of damage or an accident outcome.
