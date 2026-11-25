// SPDX-License-Identifier: Apache-2.0
import { PARAMETERS, PWRPlant } from './engine.js';

export const PAIRED_METRICS = Object.freeze({
  electricPower: { label: 'Net generation', unit: 'MWe' },
  thermalPower: { label: 'Thermal power', unit: 'MWth' },
  primaryPressure: { label: 'Primary pressure', unit: 'MPa' },
  steamPressure: { label: 'Steam pressure', unit: 'MPa' },
});
const metrics = Object.keys(PAIRED_METRICS);
const stepsPerSecond = 1 / PARAMETERS.maxStepS;
// SHA-256 of the normalized sources used by the browser plant (checked by the
// regression suite). Change the protocol prefix when command or sampling order changes.
const LEGACY_MODEL_REVISION = 'paired-0.05s-v1/f91d368c45ffc62df8d9f7c5a1d90b4316b6fdf33f7e00bfb1a32d46f081cfe6';
export const PAIRED_MODEL_REVISION = 'paired-0.05s-v1/c2641847b6495f519dc702ddc72c3992a88283222670a9b5f59009ac596e2488';

function revisionForState(model) {
  // The engine has validated the state and upgraded any v1 save to v2.
  if (model.schema === 'openpwr-state-v2') return LEGACY_MODEL_REVISION;
  if (model.schema === 'openpwr-state-v3') return PAIRED_MODEL_REVISION;
  throw new TypeError('Unsupported plant state for paired experiments.');
}

function observation(elapsedS, baseline, alternative) {
  const row = { elapsedS, time: baseline.time, baseline: { tripped: baseline.tripped },
    alternative: { tripped: alternative.tripped }, delta: {} };
  for (const metric of metrics) {
    row.baseline[metric] = baseline[metric];
    row.alternative[metric] = alternative[metric];
    row.delta[metric] = alternative[metric] - baseline[metric];
  }
  return row;
}

function validateOptions(demand, durationS) {
  if (!Number.isFinite(demand) || demand < 0.25 || demand > 1) {
    throw new RangeError('Net demand must be between 25% and 100%.');
  }
  if (!Number.isInteger(durationS) || durationS < 1 || durationS > 1800) {
    throw new RangeError('Duration must be a whole number of seconds from 1 to 1800.');
  }
}

function restoreOperatingPlant(model) {
  const plant = new PWRPlant();
  const s = plant.importState(model);
  if (s.domainExceeded || s.tripped || s.startupStage !== 'power' || !s.gridConnected) {
    throw new RangeError('Capture an untripped, grid-connected power-mode model within its validity range.');
  }
  return plant;
}

export function validatePairedRecipe(recipe) {
  const fields = ['format', 'version', 'modelRevision', 'model', 'demand', 'durationS'];
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)
      || Object.keys(recipe).length !== fields.length || !fields.every(key => Object.hasOwn(recipe, key))
      || recipe.format !== 'openpwr-paired-run' || recipe.version !== 1) {
    throw new TypeError('Unsupported paired experiment recipe or version.');
  }
  const { demand, durationS } = recipe;
  validateOptions(demand, durationS);
  const model = restoreOperatingPlant(recipe.model).exportState();
  if (recipe.modelRevision !== revisionForState(model)) throw new TypeError('Paired recipe revision does not match the saved browser model.');
  return { model, demand, durationS };
}

/** Compare one net-demand edit with continuing the captured browser controls. */
export async function runPairedExperiment(model, { demand, durationS }, { signal, onProgress } = {}) {
  validateOptions(demand, durationS);
  signal?.throwIfAborted();
  const baseline = restoreOperatingPlant(model);
  let base = baseline.snapshot();
  const alternative = new PWRPlant();
  let alt = alternative.importState(model);
  const checkpoint = baseline.exportState();
  const result = {
    startTime: base.time, durationS, elapsedS: 0, baselineDemand: base.controls.demand, demand,
    complete: false, stopReason: '', stopElapsedS: null, baselineTrip: null, alternativeTrip: null,
    rows: [observation(0, base, alt)],
    recipe: { format: 'openpwr-paired-run', version: 1, modelRevision: revisionForState(checkpoint),
      model: checkpoint, demand, durationS },
  };
  alternative.setControl('demand', demand);
  onProgress?.(0);
  const ticks = durationS * stepsPerSecond;
  let lastYield = performance.now();
  for (let tick = 1; tick <= ticks; tick++) {
    signal?.throwIfAborted();
    const nextBase = baseline.step(PARAMETERS.maxStepS);
    const nextAlt = alternative.step(PARAMETERS.maxStepS);
    if (nextBase.domainExceeded || nextAlt.domainExceeded) {
      // A solver may stop before committing its clock, after partially updating
      // state. Only the preceding pair is known to be valid and simultaneous.
      const previousS = (tick - 1) / stepsPerSecond;
      if (result.rows.at(-1).elapsedS !== previousS) result.rows.push(observation(previousS, base, alt));
      result.elapsedS = previousS;
      const stops = [
        { name: 'Baseline', state: nextBase },
        { name: 'Alternative', state: nextAlt },
      ].filter(({ state }) => state.domainExceeded);
      const firstTime = Math.min(...stops.map(({ state }) => state.time));
      result.stopElapsedS = firstTime === base.time ? previousS : tick / stepsPerSecond;
      result.stopReason = stops.filter(({ state }) => state.time === firstTime)
        .map(({ name, state }) => `${name}: ${state.domainReason}`).join(' · ');
      onProgress?.(result.elapsedS / durationS);
      signal?.throwIfAborted();
      return result;
    }
    base = nextBase;
    alt = nextAlt;
    const elapsedS = tick / stepsPerSecond;
    if (base.tripped && !result.baselineTrip) result.baselineTrip = { elapsedS, reason: base.tripReason };
    if (alt.tripped && !result.alternativeTrip) result.alternativeTrip = { elapsedS, reason: alt.tripReason };
    if (tick % stepsPerSecond === 0) {
      result.rows.push(observation(elapsedS, base, alt));
      if (tick < ticks && performance.now() - lastYield >= 12) {
        onProgress?.(elapsedS / durationS);
        await new Promise(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  }
  result.elapsedS = durationS;
  result.complete = true;
  onProgress?.(1);
  signal?.throwIfAborted();
  return result;
}

export function pairedRunCsv(result) {
  const branches = ['baseline', 'alternative', 'delta'];
  const headings = ['elapsed_s', 'model_time_s', 'baseline_demand_fraction', 'alternative_demand_fraction',
    'baseline_tripped', 'alternative_tripped'];
  for (const metric of metrics) {
    for (const branch of branches) headings.push(`${branch}_${metric}_${PAIRED_METRICS[metric].unit}`);
  }
  const lines = [headings.join(',')];
  for (const row of result.rows) {
    const values = [row.elapsedS, row.time, result.baselineDemand, result.demand,
      Number(row.baseline.tripped), Number(row.alternative.tripped)];
    for (const metric of metrics) {
      for (const branch of branches) values.push(row[branch][metric]);
    }
    lines.push(values.join(','));
  }
  return lines.join('\n') + '\n';
}
