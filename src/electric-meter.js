// SPDX-License-Identifier: Apache-2.0
// Native workbench CSV uses unquoted field names and numeric/Boolean observations.
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_LINE = 128 * 1024;
const MAX_POINTS = 36002; // 36,001 retained observations plus a fractional final step.
const numberSyntax = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function powerCsvReader() {
  const points = [];
  let indices, width, remainder = '';
  function row(line) {
    if (line.length > MAX_LINE) throw new Error('A CSV row exceeds the workbench format.');
    const cells = line.trimEnd().split(',');
    if (!indices) {
      cells[0] = cells[0].replace(/^\uFEFF/, '');
      indices = ['time', 'netPowerMW', 'grossPowerMW'].map(name => {
        const i = cells.indexOf(name);
        if (i < 0 || cells.lastIndexOf(name) !== i) throw new Error('Use a native CSV with time, netPowerMW and grossPowerMW columns.');
        return i;
      });
      width = cells.length;
      return;
    }
    if (cells.length !== width) throw new Error('A CSV row has missing or extra fields.');
    if (points.length >= MAX_POINTS) throw new Error('This file exceeds the native workbench history limit.');
    const [elapsedSeconds, netPowerMW, grossPowerMW] = indices.map(i => {
      const value = cells[i].trim();
      if (!numberSyntax.test(value) || !Number.isFinite(Number(value))) throw new Error('The CSV has an invalid time or power reading.');
      return Number(value);
    });
    const previous = points.at(-1);
    if (elapsedSeconds < 0 || elapsedSeconds > Number.MAX_SAFE_INTEGER || (previous && elapsedSeconds <= previous.elapsedSeconds)) {
      throw new Error('CSV times must be nonnegative and strictly increasing.');
    }
    // The native CSV history records every simulated second and may also contain event rows.
    if (previous && elapsedSeconds - previous.elapsedSeconds > 1.000001) throw new Error('Native observations are missing between CSV rows.');
    points.push({elapsedSeconds, netPowerMW, grossPowerMW});
  }
  return {
    append(chunk) {
      const lines = (remainder + chunk).split('\n');
      remainder = lines.pop();
      for (const line of lines) row(line);
      if (remainder.length > MAX_LINE) throw new Error('A CSV row exceeds the workbench format.');
    },
    finish() {
      if (remainder) row(remainder);
      if (points.length < 2) throw new Error('Export a run with at least two observations.');
      return points;
    }
  };
}

export function parseNativePowerCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('Choose a native CSV of up to 128 MiB.');
  const parser = powerCsvReader();
  parser.append(text);
  return parser.finish();
}

export async function readNativePowerFile(file) {
  if (file.size > MAX_BYTES) throw new Error('Choose a native CSV of up to 128 MiB.');
  const parser = powerCsvReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  for (let i = 0; i < file.size; i += 256 * 1024) {
    const chunk = await file.slice(i, i + 256 * 1024).arrayBuffer();
    parser.append(decoder.decode(chunk, {stream: true}));
  }
  parser.append(decoder.decode());
  return parser.finish();
}

// Integrate linear segments between retained observations over complete fixed windows
// on the simulation clock. Signed net power includes station imports.
export function averageMeterIntervals(points, intervalSeconds) {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) throw new Error('Choose a positive whole-second metering interval.');
  if (!Array.isArray(points) || !points.length) return [];
  for (const [i, p] of points.entries()) {
    if (![p.elapsedSeconds, p.netPowerMW, p.grossPowerMW].every(Number.isFinite) || p.elapsedSeconds < 0
        || p.elapsedSeconds > Number.MAX_SAFE_INTEGER || (i && p.elapsedSeconds <= points[i-1].elapsedSeconds)) {
      throw new Error('Metering requires finite power readings in increasing time order.');
    }
    if (i && p.elapsedSeconds - points[i-1].elapsedSeconds > intervalSeconds) throw new Error('The observations are too far apart for this metering interval.');
  }
  let startSeconds = Math.ceil(points[0].elapsedSeconds / intervalSeconds) * intervalSeconds;
  const result = [];
  let segment = 1;
  while (startSeconds + intervalSeconds <= points.at(-1).elapsedSeconds) {
    const endSeconds = startSeconds + intervalSeconds;
    let time = startSeconds, netMWseconds = 0, grossMWseconds = 0;
    while (time < endSeconds) {
      while (points[segment].elapsedSeconds <= time) segment++;
      const left = points[segment-1], right = points[segment];
      const next = Math.min(right.elapsedSeconds, endSeconds);
      // A linear function's interval mean equals its midpoint value.
      const fraction = ((time - left.elapsedSeconds) + (next - time) / 2) / (right.elapsedSeconds - left.elapsedSeconds);
      const duration = next - time;
      netMWseconds += duration * (left.netPowerMW + fraction * (right.netPowerMW - left.netPowerMW));
      grossMWseconds += duration * (left.grossPowerMW + fraction * (right.grossPowerMW - left.grossPowerMW));
      time = next;
    }
    result.push({startSeconds, endSeconds, energyMWh: netMWseconds / 3600, averageNetMW: netMWseconds / intervalSeconds,
      grossEnergyMWh: grossMWseconds / 3600, averageGrossMW: grossMWseconds / intervalSeconds});
    startSeconds = endSeconds;
  }
  return result;
}
