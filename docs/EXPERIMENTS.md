# Experiments in the simulator

These are experiments on a generic mathematical model, not operating instructions for any real facility. Begin with a fresh nominal, half-load, or cold state for repeatable comparisons. Record the version, initial state, control changes, and simulation time.

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

## 7. Cold-start experiment

Choose **Initialize cold shutdown**. The experiment starts paused at 25 °C with a stationary turbine, disconnected generator, and subcritical source-supported neutron population. Select **Establish circulation**, then **Run**. The interface explains why later actions are unavailable; their permissives come from measured model state.

When enabled, select **Begin reactor heat-up**. The default 1% thermal request produces a gradual reactor-assisted heatup. Use accelerated speed for the multi-hour thermal transient; the displayed actual rate can be lower than the requested rate on a slower device. The solver step remains 50 ms. The **Last 12 hours** trend window shows the rise rather than only its final few minutes.

When enabled, select **Hold hot conditions**, then **Roll turbine**. The rotor accelerates from steam power while electrical output remains auxiliary import. **Connect generator** becomes available near rated speed and with adequate hot conditions. It starts a 250 MWe load request; increasing load then moves the reactor and turbine controllers. These are generic model actions, not actual plant operating procedures. The hot-hold stage retains low reactor power and does not represent subcritical plant Mode 3.

**Disconnect / trip** demonstrates load rejection: the grid breaker opens, reactor protection latches, and the rotor responds to the remaining steam and its modeled losses. Save and reload at an intermediate stage to repeat an experiment without reinitializing thermal or fission-product inventories.

Headless equivalent:

```sh
npm run simulate -- --scenario=cold-start --duration=36000 --output=artifacts/cold-start.csv
```

This director observes permissives once per simulated second, applies the same public actions, and raises demand by 10 MWe per minute after connection. Its metadata records every applied action. The default model reaches grid connection at roughly 5 h 43 min; this is a model result, not a validated startup duration. `npm run verify` reproduces the sequence and publishes a one-minute trace alongside its acceptance checks.

## Files and time

Snapshots preserve model state for deterministic continuation; they do not encode a complete operator action history. CSV exports provide measured history with units documented in the model and accompanying headless JSON. The browser retains up to 24 hours of one-second samples; chart display decimation preserves extrema but CSV exports the retained samples plus the current observation. A paused action is therefore reflected in the final CSV row even before the next sampling interval. Simulation speed changes the amount of simulated time per wall-clock second, not the physical parameters. Background tabs may be throttled; use the CLI for reproducible long runs.

When a domain limit is reached, the simulation stops and identifies the reason. A stop is the boundary of the mathematical model, not a prediction of damage or an accident outcome.
