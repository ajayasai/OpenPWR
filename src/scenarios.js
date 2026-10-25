// SPDX-License-Identifier: Apache-2.0
// Reproducible inputs for the generic simulator, not a plant operating procedure.
export const COLD_START_ACTIONS = Object.freeze(['prepare', 'startHeatup', 'holdHotStandby', 'rollTurbine', 'connectGrid']);

/** Call on integer-second simulation boundaries. All changes use the public API;
 * the director does not set physical state or bypass startup permissives.
 * After grid connection, the net demand rises 10 MWe per simulated minute.
 */
export function createColdStartDirector() {
  let nextAction = 0;
  let connectionTime = null;
  let lastDemand = null;
  const actions = [];
  return {
    get actions() { return actions.map(action => ({ ...action })); },
    update(plant) {
      const before = plant.snapshot();
      if (before.domainExceeded || before.tripped) return;
      const action = COLD_START_ACTIONS[nextAction];
      if (action && before.startupPermissives?.[action]?.allowed) {
        const result = plant.startupAction(action);
        if (!result.ok) throw new Error(`Startup permissive/action disagreement: ${action}: ${result.message}`);
        actions.push({ time: before.time, action });
        nextAction += 1;
        if (action === 'connectGrid') connectionTime = before.time;
      }
      if (connectionTime !== null && plant.snapshot().gridConnected) {
        // Piecewise minute ramps make the input history compact and reproducible.
        const demand = Math.min(1, 0.25 + 0.01 * Math.floor((before.time - connectionTime + 1e-7) / 60));
        if (demand !== lastDemand) {
          plant.setControl('demand', demand);
          lastDemand = demand;
          actions.push({ time: before.time, action: 'demand', value: demand });
        }
      }
    },
  };
}
