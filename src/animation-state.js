// SPDX-License-Identifier: Apache-2.0
import { PARAMETERS } from './engine.js';

const finite = value => Number.isFinite(value) ? value : 0;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, finite(value)));
const rate = (value, nominal = 1) => clamp(finite(value) / nominal, -2, 2);

// Presentation only: normalize the engine's observations without changing them.
// These bounded rates express relative activity, not fluid velocity or literal
// shaft revolutions. Feed-pump speed is an illustration derived from mass flow;
// the model has no separate feed-pump rotor state.
export function diagramState(snapshot = {}) {
  const s = snapshot ?? {};
  const steam = rate(s.steamFlow, PARAMETERS.nominalSteamFlowKgS);
  const feed = rate(s.feedFlow, PARAMETERS.nominalSteamFlowKgS);
  const rotor = rate(s.turbineSpeed, 3000);
  return {
    rates: {
      primary: rate(s.primaryFlow, PARAMETERS.primaryFlowKgS),
      steamHeader: steam,
      steam: rate(s.turbineSteamFlow, PARAMETERS.nominalSteamFlowKgS),
      bypass: rate(s.bypassSteamFlow, PARAMETERS.nominalSteamFlowKgS),
      feed,
      cooling: s.faults?.lossOfHeatSink ? 0 : rate(s.controls?.cooling),
      // This wire represents the generator lead, not the plant auxiliary supply.
      // Negative gross output during synchronization is generator motoring.
      grid: s.gridConnected ? rate(s.grossPower, 1050) : 0,
    },
    rotors: {
      primary: rate(s.pumpSpeed),
      feed,
      turbine: rotor,
      generator: rotor,
    },
    heat: clamp(finite(s.thermalPower) / PARAMETERS.thermalMW, 0, 1),
    steamActivity: clamp(Math.abs(steam), 0, 1),
  };
}

// Integrate visual motion on a bounded wall clock. Zero elapsed time freezes
// phase; long frame gaps never cause a catch-up jump. Rates may be negative.
export function advancePhase(phase, rate, elapsed, period = 1) {
  const cycle = Number.isFinite(period) && period > 0 ? period : 1;
  const next = finite(phase) + finite(rate) * clamp(elapsed, 0, 0.1);
  return ((next % cycle) + cycle) % cycle;
}
