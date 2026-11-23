// SPDX-License-Identifier: Apache-2.0
/** Reproduce the paired scores on the pressure report's acquired time grid. */
export function compareAcquiredPressure(channel, acquiredTimes) {
  const diagnosticTimes = channel?.pressureDiagnostics?.sampleGridSeconds;
  if (channel?.key !== 'primaryPressureMPa' || channel.unit !== 'MPa' || !Array.isArray(channel.points)
      || !Array.isArray(acquiredTimes) || !acquiredTimes.length || !Array.isArray(diagnosticTimes)
      || diagnosticTimes.length !== acquiredTimes.length || acquiredTimes.some((time, i) =>
        !Number.isFinite(time) || time <= 0 || time !== diagnosticTimes[i] || (i > 0 && time <= acquiredTimes[i - 1]))) {
    throw new Error('The report does not identify a consistent acquired pressure time grid.');
  }
  const rows = acquiredTimes.map(time => {
    const matches = channel.points.filter(point => point.time === time);
    if (matches.length !== 1) throw new Error(`Expected one pressure observation at ${time} s.`);
    const { measured, baseline, simulated } = matches[0];
    if (![measured, baseline, simulated].every(Number.isFinite)) throw new Error(`Incomplete pressure comparison at ${time} s.`);
    const baselineError = baseline - measured;
    const candidateError = simulated - measured;
    const difference = Math.abs(candidateError) - Math.abs(baselineError);
    const roundoff = 4 * Number.EPSILON * Math.max(1, Math.abs(measured), Math.abs(baseline), Math.abs(simulated));
    const closer = Math.abs(difference) <= roundoff ? 'Tie' : difference < 0 ? 'Candidate' : 'Released';
    return { time, measured, baseline, simulated, baselineError, candidateError, closer };
  });
  function scores(key) {
    const bias = rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
    const rmse = Math.sqrt(rows.reduce((sum, row) => sum + row[key] ** 2, 0) / rows.length);
    return { bias, rmse };
  }
  const baseline = scores('baselineError'), candidate = scores('candidateError');
  const metrics = channel.metrics;
  if (metrics?.samples !== rows.length
      || [[baseline.rmse, metrics.releasedBaselineRmse], [candidate.rmse, metrics.rmse], [candidate.bias, metrics.meanError]]
        .some(([computed, recorded]) => !Number.isFinite(recorded) || !Number.isFinite(computed)
          || Math.abs(computed - recorded) > 1e-12 * Math.max(1, Math.abs(recorded)))) {
    throw new Error('The reconstructed sample count or pressure errors disagree with the published scores.');
  }
  return { rows, baseline, candidate };
}
