// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export const viewSources = new Map([
  'plant-verification', 'measured-validation', 'continuous-measured-validation',
  'krsko-pressure-development', 'pressurizer-validation',
].map(name => [name + '.view.json', name + '.json']));

function pick(object, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

function channelView(channel) {
  const view = pick(channel, ['name', 'label', 'key', 'unit', 'metrics', 'description']);
  view.points = channel.points.map(point => pick(point, [
    'time', 'measured', 'simulated', 'baseline', 'noWall', 'originalNoSpray', 'lowerAllowance', 'upperAllowance',
  ]));
  if (channel.pressureDiagnostics) view.pressureDiagnostics = pick(channel.pressureDiagnostics, ['sampleGridSeconds']);
  return view;
}

function measuredView(report) {
  const view = pick(report, [
    'schema', 'version', 'gitRevision', 'gitDirty', 'caseId', 'title', 'executed', 'error', 'status',
    'conclusion', 'scope', 'comparisonRole', 'heldOutFromCurrentDevelopment', 'comparisonWindowS',
    'physicalValidationPassed', 'validationPassed', 'independentValidationPassed', 'numericalPassed',
    'inputDataSha256', 'coldSourceSha256', 'pressureSourceSha256', 'assumptions', 'numericalEvidence',
    'numericalChecks',
  ]);
  if (report.source) view.source = pick(report.source, ['title', 'url']);
  if (report.runtime) view.runtime = pick(report.runtime, ['model', 'fmuSha256', 'fmiVersion']);
  if (report.releasedBaseline) view.releasedBaseline = pick(report.releasedBaseline, ['version', 'gitRevision', 'reportSha256', 'sha256']);
  if (report.protocol) {
    view.protocol = pick(report.protocol, ['metricSampleTimesSeconds']);
    if (report.protocol.reference) view.protocol.reference = pick(report.protocol.reference, ['metricSampleTimesSeconds']);
  }
  if (report.pairedGuards) view.pairedGuards = pick(report.pairedGuards, ['caseImprovementPassed', 'checks']);
  if (Array.isArray(report.channels)) view.channels = report.channels.map(channelView);
  if (report.conditionalSpray) view.conditionalSpray = measuredView(report.conditionalSpray);
  if (report.holdoutComparison) view.holdoutComparison = measuredView(report.holdoutComparison);
  return view;
}

// All values come from the canonical bytes. Nothing is rounded, resampled or inferred.
export function makeEvidenceView(filename, bytes) {
  const parsed = JSON.parse(bytes);
  let report;
  if (filename === 'plant-verification.json') {
    report = pick(parsed, ['version', 'gitRevision', 'gitDirty', 'total', 'passed', 'checks']);
    report.runtime = pick(parsed.runtime, ['model', 'fmuSha256']);
    report.buildManifest = pick(parsed.buildManifest, ['sourceSha256']);
  } else {
    report = measuredView(parsed);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return JSON.stringify({ schema: 'openpwr-evidence-view-v1', source: { file: filename, bytes: bytes.length, sha256 }, report }) + '\n';
}
