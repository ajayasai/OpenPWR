// SPDX-License-Identifier: Apache-2.0
import {outputs, validateEvidence, validHash} from './continuous-state.js';

export const replayPath = './validation/startup_output/replay.json';
export const replaySha256 = '935242a76f165e6cf5e2c0be59ebb1a0812ff5477c09b2667bb096eb14092c40';
export const startupIndexPath = './continuous-index.json';
export const currentReplayPath = './continuous-recording.json';

export function validateStartupIndex(index) {
  validateEvidence(index);
  const {source, recording} = index;
  if (index.schema !== 'openpwr-native-startup-index-v1' || index.passed !== index.total
      || !/^\d+\.\d+\.\d+$/.test(index.version) || source?.release !== 'v' + index.version
      || !/^[a-f0-9]{40}$/.test(source.gitRevision) || typeof source.gitDirty !== 'boolean'
      || source.url !== './continuous-verification.json' || source.scenarioId !== 'full-startup'
      || source.fmuSha256 !== index.runtime.fmuSha256 || !validHash(source.reportSha256)
      || !Number.isSafeInteger(source.reportBytes) || source.reportBytes <= 0 || !validHash(recording?.sha256)
      || !Number.isSafeInteger(recording.bytes) || recording.bytes <= 0
      || !Number.isFinite(recording.durationSeconds) || !Number.isFinite(recording.sampleIntervalSeconds)
      || recording.sampleIntervalSeconds <= 0 || recording.durationSeconds < recording.sampleIntervalSeconds
      || !Number.isSafeInteger(recording.durationSeconds / recording.sampleIntervalSeconds)) {
    throw new Error('The startup index has incompatible source or recording identities.');
  }
  return index;
}

export async function decodeRecording(bytes, index) {
  if (index !== undefined) validateStartupIndex(index);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (index ? (hex !== index.recording.sha256 || bytes.byteLength !== index.recording.bytes) : hex !== replaySha256) {
    throw new Error(index ? 'The recording differs from the verified build index.' : 'The recording differs from the published v0.11 projection.');
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (index && (Object.keys(index.source).some(key => data.source?.[key] !== index.source[key])
      || data.durationSeconds !== index.recording.durationSeconds || data.sampleIntervalSeconds !== index.recording.sampleIntervalSeconds)) {
    throw new Error('The recording and verification index describe different native runs.');
  }
  const {columns, rows, sampleIntervalSeconds, durationSeconds} = data;
  if (data.schema !== 'openpwr-native-startup-replay-v1' || !Array.isArray(columns) || columns[0] !== 'time'
      || columns.length !== outputs.length + 1 || outputs.some(key => !columns.includes(key))
      || !Array.isArray(rows) || rows.length !== durationSeconds / sampleIntervalSeconds + 1) {
    throw new Error('The recorded startup is incompatible with this workbench.');
  }
  const points = rows.map((values, index) => {
    if (values.length !== columns.length || values[0] !== index * sampleIntervalSeconds ||
        values.some(value => !Number.isFinite(value))) {
      throw new Error('The recording contains an incomplete native observation.');
    }
    return Object.fromEntries(columns.map((key, i) => [key, values[i]]));
  });
  return {points, sampleIntervalSeconds, durationSeconds, source: data.source};
}

// The display holds the most recent recorded sample, including discrete breaker and trip states.
export function sampleIndex(recording, seconds) {
  return Math.max(0, Math.min(recording.points.length - 1, Math.floor(seconds / recording.sampleIntervalSeconds)));
}
