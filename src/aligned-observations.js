// SPDX-License-Identifier: Apache-2.0
import { compareAcquiredPressure } from './acquired-pressure.js';

export const pressureSchemas = ['openpwr-krsko-pressure-development-v1', 'openpwr-krsko-pressure-spray-development-v1'];
const pactelCases = ['pactel-1998-atws10-pressurizer', 'pactel-1998-atws11-compression-holdout'];

function matchingScore(computed, reported) {
  return Number.isFinite(reported) && Number.isFinite(computed)
    && Math.abs(computed - reported) <= 1e-12 * Math.max(1, Math.abs(reported));
}

function scoredTimes(report, channel, graphical) {
  if (graphical) {
    const [start, end] = report.comparisonWindowS || [];
    // PACTEL is scored on successive one-second positions on a digitized curve.
    if (!Number.isInteger(start) || !Number.isInteger(end) || end - start + 1 !== channel.points.length
        || !channel.points.every((point, i) => point.time === start + i)) {
      throw new Error('The graphical positions disagree with the reported comparison window.');
    }
    return channel.points.map(point => point.time);
  }
  const times = report.protocol?.reference?.metricSampleTimesSeconds
    ?? report.protocol?.metricSampleTimesSeconds ?? report.numericalEvidence?.metricSampleTimesS;
  if (!Array.isArray(times) || !times.length || times.some((time, i) =>
    !Number.isFinite(time) || time <= 0 || (i > 0 && time <= times[i - 1]))) {
    throw new Error('The acquired scoring times are missing or inconsistent.');
  }
  return times;
}

/** Select only the report's aligned, scored positions. No interpolation or curve fitting occurs here. */
export function alignedObservations(report, channel) {
  if (!Array.isArray(channel?.points) || !channel.points.length || channel.points.length > 20000) {
    throw new Error('Expected recorded response points.');
  }
  const graphical = pactelCases.includes(report.caseId);
  const times = scoredTimes(report, channel, graphical);
  const points = new Map(channel.points.map(point => [point.time, point]));
  if (points.size !== channel.points.length || times.length !== channel.metrics?.samples) {
    throw new Error('Duplicate timestamps or a sample count inconsistent with the scores.');
  }
  const candidateName = report.schema === pressureSchemas[1] ? 'Conditional spray'
    : report.schema === pressureSchemas[0] ? 'Finite phase with wall' : 'Native model';
  const series = [{ key: 'simulated', label: candidateName }];
  if (report.releasedBaseline || channel.points.some(point => Number.isFinite(point.baseline))) {
    if (typeof report.releasedBaseline?.version !== 'string') throw new Error('The released prediction has no version identifier.');
    series.push({ key: 'baseline', label: 'Released v' + report.releasedBaseline.version });
  }
  if (pressureSchemas.includes(report.schema)) {
    const spray = report.schema === pressureSchemas[1];
    series.push({ key: spray ? 'originalNoSpray' : 'noWall', label: spray ? 'Without spray' : 'Without wall heat transfer' });
  }
  const special = pressureSchemas.includes(report.schema) && channel.key === 'primaryPressureMPa'
    ? compareAcquiredPressure(channel, times) : null;
  const rows = times.map((time, i) => {
    const point = points.get(time);
    if (!Number.isFinite(point?.measured) || !series.every(s => Number.isFinite(point[s.key]))) {
      throw new Error('Missing measurement or prediction at ' + time + ' s.');
    }
    const row = { time, measured: point.measured };
    for (const { key } of series) {
      row[key] = point[key];
      row[key + 'Error'] = point[key] - point.measured;
    }
    if (graphical) {
      if (!Number.isFinite(point.lowerAllowance) || !Number.isFinite(point.upperAllowance)
          || point.lowerAllowance > point.measured || point.upperAllowance < point.measured) {
        throw new Error('Incomplete conditional allowance at ' + time + ' s.');
      }
      row.lowerAllowance = point.lowerAllowance;
      row.upperAllowance = point.upperAllowance;
    }
    if (special) row.closer = special.rows[i].closer;
    return row;
  });
  const scores = {};
  for (const { key } of series) {
    const errors = rows.map(row => row[key + 'Error']);
    scores[key] = {
      rmse: Math.sqrt(errors.reduce((sum, n) => sum + n * n, 0) / rows.length),
      bias: errors.reduce((sum, n) => sum + n, 0) / rows.length,
    };
  }
  const metrics = channel.metrics;
  if (!matchingScore(scores.simulated.rmse, metrics.rmse) || !matchingScore(scores.simulated.bias, metrics.meanError)
      || (scores.baseline && !matchingScore(scores.baseline.rmse, metrics.releasedBaselineRmse ?? metrics.v07BaselineRmse))) {
    throw new Error('The aligned rows do not reproduce the reported error scores.');
  }
  return { graphical, special: Boolean(special), series, rows, scores, unit: channel.unit, channel: channel.key,
    caseId: report.caseId, reportSchema: report.schema, role: report.comparisonRole || 'boundary-driven response comparison',
    sourceSha256: report.inputDataSha256, revision: report.gitRevision, fmuSha256: report.runtime.fmuSha256 };
}

/** Export every scored row at the source precision, independently of the visible table page. */
export function observationsCsv(view) {
  const columns = ['case_id', 'case_schema', 'comparison_role', 'channel', 'unit', 'time_basis', 'data_sha256', 'git_revision', 'fmu_sha256', 'time_s', 'measured'];
  for (const { key } of view.series) columns.push(key, key + '_minus_measured');
  if (view.graphical) columns.push('conditional_lower', 'conditional_upper');
  if (view.special) columns.push('closer_model');
  const common = [view.caseId, view.reportSchema, view.role, view.channel, view.unit,
    view.graphical ? 'graphical position' : 'acquired sample', view.sourceSha256, view.revision, view.fmuSha256];
  const escape = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value);
  const lines = [columns.join(',')];
  for (const row of view.rows) {
    const values = [...common, row.time, row.measured];
    for (const { key } of view.series) values.push(row[key], row[key + 'Error']);
    if (view.graphical) values.push(row.lowerAllowance, row.upperAllowance);
    if (view.special) values.push(row.closer);
    lines.push(values.map(escape).join(','));
  }
  return lines.join('\n') + '\n';
}
