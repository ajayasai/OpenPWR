// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { MODEL, outputs, validateEvidence, validHash } from '../src/continuous-state.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Extract the workbench's columns without rounding, resampling, or interpolating the native trace. */
export function makeStartupViews(reportBytes) {
  const report = validateEvidence(JSON.parse(new TextDecoder().decode(reportBytes)));
  const matches = report.scenarios?.filter(caseData => caseData.id === 'full-startup');
  const run = matches?.[0];
  const manifest = report.buildManifest;
  if (report.schemaVersion !== 1 || report.passed !== report.total || matches?.length !== 1
      || !/^\d+\.\d+\.\d+$/.test(report.version) || !/^[a-f0-9]{40}$/.test(report.gitRevision)
      || typeof report.gitDirty !== 'boolean'
      || manifest?.version !== report.version || manifest.gitRevision !== report.gitRevision
      || manifest.model !== MODEL || !validHash(manifest.fmuSha256)
      || manifest.fmuSha256 !== report.runtime.fmuSha256 || run.runtime?.model !== MODEL
      || run.runtime.fmuSha256 !== manifest.fmuSha256 || run.complete !== true
      || run.singleFmuInstance !== true || run.resetCount !== 0) {
    throw new Error('The startup recording requires one complete native run with matching report and executable identities.');
  }
  const { durationSeconds, sampleIntervalSeconds } = run;
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(sampleIntervalSeconds)
      || durationSeconds <= 0 || sampleIntervalSeconds <= 0 || !Array.isArray(run.trace)
      || run.trace.length !== durationSeconds / sampleIntervalSeconds + 1) {
    throw new Error('The startup recording has an incomplete time grid.');
  }
  const columns = ['time', ...outputs];
  const rows = run.trace.map((sample, i) => {
    if (sample?.time !== i * sampleIntervalSeconds || outputs.some(key => !Number.isFinite(sample[key]))) {
      throw new Error(`Incomplete native observation at sample ${i}.`);
    }
    return columns.map(key => sample[key]);
  });
  const source = { release: 'v' + report.version, gitRevision: report.gitRevision, gitDirty: report.gitDirty,
    url: './continuous-verification.json', reportSha256: digest(reportBytes), reportBytes: reportBytes.length,
    scenarioId: run.id, fmuSha256: manifest.fmuSha256 };
  const recording = JSON.stringify({ schema: 'openpwr-native-startup-replay-v1', source,
    durationSeconds, sampleIntervalSeconds, columns, rows }) + '\n';
  const index = JSON.stringify({ schema: 'openpwr-native-startup-index-v1', version: report.version, source,
    runtime: { model: MODEL, fmuSha256: manifest.fmuSha256 }, physicalValidationPassed: report.physicalValidationPassed,
    total: report.total, passed: report.passed, checks: report.checks.map(({ name, pass }) => ({ name, pass })),
    recording: { sha256: digest(recording), bytes: Buffer.byteLength(recording), durationSeconds, sampleIntervalSeconds } }) + '\n';
  return { index, recording };
}
