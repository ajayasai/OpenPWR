// SPDX-License-Identifier: Apache-2.0
import {outputs} from './continuous-state.js';

export const replayPath = './validation/startup_output/replay.json';
export const replaySha256 = '935242a76f165e6cf5e2c0be59ebb1a0812ff5477c09b2667bb096eb14092c40';

export async function decodeRecording(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== replaySha256) throw new Error('The recording differs from the published v0.11 projection.');
  const data = JSON.parse(new TextDecoder().decode(bytes));
  const {columns, rows, sampleIntervalSeconds, durationSeconds} = data;
  if (data.schema !== 'openpwr-native-startup-replay-v1' || columns[0] !== 'time' ||
      outputs.some(key => !columns.includes(key)) || rows.length !== durationSeconds / sampleIntervalSeconds + 1) {
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
