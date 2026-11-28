// SPDX-License-Identifier: Apache-2.0
import { averageMeterIntervals, readNativePowerFile } from './electric-meter.js';

const byId = id => document.getElementById(id);
const plantUrl = './validation/grid_return/sizewell-b-2024.json';
const modelUrl = './validation/startup_output/model.json';
const powerFormat = new Intl.NumberFormat('en', {maximumFractionDigits: 2});
const dayFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'UTC', day: '2-digit', month: 'short'});
const utcFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const periodSeconds = 1800;
let measuredRows, releasedRows, nativeRows, nativeBins;
let loadGeneration = 0;

async function load(url, schema) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const report = await response.json();
  if (report.schema !== schema || !Array.isArray(report.points) || !report.points.length) {
    throw new Error('Unexpected record format.');
  }
  return report;
}

function status(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle('error', error);
}

function svgElement(tag, attributes, value) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, val);
  if (value !== undefined) element.textContent = value;
  return element;
}

function elapsed(seconds) {
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const fraction = (seconds - whole).toFixed(6).slice(1).replace(/0+$/, '').replace(/^\.$/, '');
  return parts.map(n => String(n).padStart(2, '0')).join(':') + fraction;
}

// Preserve both extrema in every screen column when a long CSV supplies many samples per pixel.
// The inspector always addresses the original samples.
function visibleIndices(rows, xValue, yValue) {
  if (rows.length < 1500) return rows.keys();
  const indices = [];
  let start = 0;
  while (start < rows.length) {
    const pixel = Math.floor(xValue(rows[start]));
    let next = start + 1, low = start, high = start;
    while (next < rows.length && Math.floor(xValue(rows[next])) === pixel) {
      if (yValue(rows[next]) < yValue(rows[low])) low = next;
      if (yValue(rows[next]) > yValue(rows[high])) high = next;
      next++;
    }
    indices.push(...new Set([start, Math.min(low, high), Math.max(low, high), next - 1]));
    start = next;
  }
  return indices;
}

function drawChart(id, rows, fields, selectTime, label) {
  const chart = byId(`${id}-plot`), slider = byId(`${id}-sample`);
  const {startKey, endKey, valueKey} = fields;
  const first = rows[0][startKey], last = rows.at(-1)[endKey || startKey];
  let low = 0, high = 0;
  for (const row of rows) {
    low = Math.min(low, row[valueKey]);
    high = Math.max(high, row[valueKey]);
  }
  const padding = Math.max(1, high - low) * .055;
  const ymin = low - padding, ymax = high + padding;
  const left = 49, right = 456, top = 22, bottom = 173;
  const x = t => left + (right - left) * (t - first) / (last - first || 1);
  const y = p => bottom - (bottom - top) * (p - ymin) / (ymax - ymin);
  chart.replaceChildren();
  chart.setAttribute('aria-label', label);
  chart.append(svgElement('text', {x: left, y: 15}, 'MW'));
  const roughStep = (ymax - ymin) / 3.6;
  const decade = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 2.5, 5, 10].find(n => n * decade >= roughStep) * decade;
  for (let level = Math.ceil(ymin / step) * step; level <= ymax; level += step) {
    chart.append(svgElement('line', {x1: left, x2: right, y1: y(level), y2: y(level), class: level === 0 ? 'zero-line' : 'grid-line'}),
      svgElement('text', {x: left - 5, y: y(level) + 4, 'text-anchor': 'end'}, level === 0 ? '0' : powerFormat.format(level)));
  }
  const middle = id === 'plant' ? first + Math.floor((last - first) / (2 * 86400000)) * 86400000 : (first + last) / 2;
  const [timeDivisor, timeUnit] = last - first < 120 ? [1, 's'] : last - first < 7200 ? [60, 'min'] : [3600, 'h'];
  const formatTick = id === 'plant' ? t => dayFormat.format(t) :
    t => `${Number((t / timeDivisor).toFixed(6))} ${timeUnit}`;
  for (const [time, anchor] of [[first, 'start'], [middle, 'middle'], [last, 'end']]) {
    chart.append(svgElement('text', {x: x(time), y: 195, 'text-anchor': anchor}, formatTick(time)));
  }
  let path = '', previousEnd;
  const xValue = row => x(row[startKey]), yValue = row => row[valueKey];
  for (const index of visibleIndices(rows, xValue, yValue)) {
    const row = rows[index];
    const gap = endKey && row[startKey] !== previousEnd;
    path += `${!path || gap ? 'M' : 'L'}${xValue(row).toFixed(2)} ${y(yValue(row)).toFixed(2)}`;
    if (endKey) path += `H${x(row[endKey]).toFixed(2)}`;
    previousEnd = row[endKey];
  }
  chart.append(svgElement('path', {d: path, class: 'trace'}));
  const marker = svgElement('line', {y1: top, y2: bottom, class: 'marker'});
  const point = svgElement('circle', {r: 4.5, class: 'point'});
  chart.append(marker, point);
  slider.max = rows.length - 1;
  slider.disabled = false;
  // Keep each cursor on its own clock when a different electrical channel is selected.
  let initialIndex = Number.isFinite(selectTime)
    ? rows.findIndex(row => row[endKey || startKey] >= selectTime)
    : 0;
  if (initialIndex < 0) initialIndex = rows.length - 1;
  slider.value = initialIndex;
  function select() {
    const row = rows[Number(slider.value)];
    const start = row[startKey], end = endKey ? row[endKey] : start;
    const time = (start + end) / 2;
    const tag = id === 'plant' ? t => utcFormat.format(t) : elapsed;
    const timestamp = endKey ? `${tag(start)} – ${tag(end)}` : tag(start);
    const reading = powerFormat.format(row[valueKey]) + ' MW';
    slider.dataset.time = time;
    marker.setAttribute('x1', x(time));
    marker.setAttribute('x2', x(time));
    point.setAttribute('cx', x(time));
    point.setAttribute('cy', y(row[valueKey]));
    byId(`${id}-output`).value = reading;
    byId(`${id}-time`).textContent = timestamp + (id === 'plant' ? ' UTC' : ' elapsed');
    slider.setAttribute('aria-valuetext', `${byId(`${id}-time`).textContent}, ${reading}`);
  }
  slider.oninput = select;
  select();
}

function showPlant() {
  const choice = byId('plant-channel');
  drawChart('plant', measuredRows, {startKey:'startMs', endKey:'endMs', valueKey:choice.value},
    Number(byId('plant-sample').dataset.time), choice.selectedOptions[0].textContent + ' in megawatts over UTC settlement periods');
}

function showModel(reset = false) {
  const gross = byId('model-channel').value === 'gross';
  const basis = byId('model-basis');
  const intervalOption = basis.querySelector('option[value="interval"]');
  intervalOption.disabled = nativeBins.length === 0;
  if (intervalOption.disabled) basis.value = 'sample';
  const interval = basis.value === 'interval';
  const fields = interval
    ? {startKey:'startSeconds', endKey:'endSeconds', valueKey:gross ? 'averageGrossMW' : 'averageNetMW'}
    : {startKey:'elapsedSeconds', valueKey:gross ? 'grossPowerMW' : 'netPowerMW'};
  drawChart('model', interval ? nativeBins : nativeRows, fields,
    reset ? NaN : Number(byId('model-sample').dataset.time),
    `${gross ? 'Gross generator' : 'Net station'} power in megawatts over simulated hours, ${basis.selectedOptions[0].textContent}.`);
  byId('model-caption').textContent = interval ? 'Complete half-hour periods · elapsed simulation time' :
    (intervalOption.disabled ? 'Instantaneous samples · recording covers no complete half-hour period' : 'Instantaneous samples · elapsed simulation time');
}

function setRun(rows, description) {
  const bins = averageMeterIntervals(rows, periodSeconds);
  nativeRows = rows;
  nativeBins = bins;
  byId('model-channel').disabled = byId('model-basis').disabled = false;
  showModel(true);
  status('model-status', description);
  byId('restore-model').disabled = !releasedRows || releasedRows === nativeRows;
}

byId('plant-channel').addEventListener('change', showPlant);
byId('model-channel').addEventListener('change', () => showModel());
byId('model-basis').addEventListener('change', () => showModel());

byId('model-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const generation = ++loadGeneration;
  status('file-status', 'Reading the local recording…');
  try {
    const rows = await readNativePowerFile(file);
    if (generation !== loadGeneration) return;
    setRun(rows, `Local recording · ${file.name} · ${rows.length.toLocaleString()} observations`);
    status('file-status', 'Showing the imported recording.');
  } catch (error) {
    if (generation === loadGeneration) status('file-status', error.message, true);
  }
});

function showReleased() {
  setRun(releasedRows, `Released v0.11.0 full startup · ${releasedRows.length} observations`);
}

function showPublishedComparison() {
  if (!measuredRows || !releasedRows) return;
  const bins = averageMeterIntervals(releasedRows, periodSeconds);
  const hoursBetweenPeriods = (rows, valueKey, timeKey, unitsPerHour) => {
    const low = rows.find(row => row[valueKey] >= 100);
    const high = rows.find(row => row[valueKey] >= 900);
    return low && high ? (high[timeKey] - low[timeKey]) / unitsPerHour : null;
  };
  const plantHours = hoursBetweenPeriods(measuredRows, 'combinedMW', 'startMs', 3600000);
  const modelHours = hoursBetweenPeriods(bins, 'averageGrossMW', 'startSeconds', 3600);
  if (plantHours === null || modelHours === null) return;
  byId('threshold-result').textContent = `In the Sizewell B record, the first periods averaging at least 100 MW and 900 MW across both meters started ${powerFormat.format(plantHours)} hours apart. In the released OpenPWR run, the first periods reaching those gross-output levels started ${powerFormat.format(modelHours * 60)} minutes apart. Sizewell B’s two generators resumed output on different days. The model follows a single-generator schedule.`;
}
byId('restore-model').addEventListener('click', () => {
  loadGeneration++;
  showReleased();
  status('file-status', '');
});

async function loadPlant() {
  try {
    const data = await load(plantUrl, 'openpwr-grid-return-observation-v1');
    measuredRows = data.points.map(row => ({...row, startMs:Date.parse(row.startUtc), endMs:Date.parse(row.endUtc)}));
    if (data.intervalMinutes !== 30 || measuredRows.length !== 7 * 48 ||
        measuredRows[0].startMs !== Date.parse(data.startUtc) || measuredRows.at(-1).endMs !== Date.parse(data.endUtc) ||
        measuredRows.some((row, i) => ![row.startMs, row.endMs, row.combinedMW, row.unit1MW, row.unit2MW].every(Number.isFinite) ||
          row.endMs - row.startMs !== periodSeconds * 1000 || (i && row.startMs !== measuredRows[i - 1].endMs))) {
      measuredRows = undefined;
      throw new Error('The series contains an invalid period or power reading.');
    }
    byId('plant-channel').disabled = false;
    showPlant();
    status('plant-status', `${measuredRows.length} consecutive half-hour periods · Elexon B1610`);
    const attribution = byId('attribution');
    attribution.append(document.createTextNode(data.attribution + ' '));
    const license = document.createElement('a');
    license.href = 'https://www.elexon.co.uk/bsc/data/balancing-mechanism-reporting-agent/copyright-licence-bmrs-data/';
    license.textContent = 'BMRS data licence';
    attribution.append(license);
    showPublishedComparison();
  } catch (error) {
    status('plant-status', `Measured data could not be loaded. ${error.message}`, true);
  }
}

async function loadReleased() {
  try {
    const data = await load(modelUrl, 'openpwr-startup-electrical-output-v1');
    releasedRows = data.points;
    if (!nativeRows) showReleased();
    else byId('restore-model').disabled = false;
    showPublishedComparison();
  } catch (error) {
    if (!nativeRows) status('model-status', `Released run could not be loaded. ${error.message}`, true);
  }
}

void loadPlant();
void loadReleased();

const measuredNumber = new Intl.NumberFormat('en', {maximumFractionDigits: 3});
const hms = seconds => (seconds < 0 ? '−' : '') + elapsed(Math.abs(seconds));
const formatValue = value => Number.isFinite(value) ? measuredNumber.format(value) : '—';

function historicalAxes(chart, xmin, xmax, values, unit, uncoveredAfter) {
  // Size the coordinate system for the actual column so mobile axis labels remain legible.
  const width = Math.max(260, Math.round(chart.getBoundingClientRect().width || 540));
  chart.setAttribute('viewBox', `0 0 ${width} 220`);
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * .08, .01);
  const left = 50, right = width - 22, top = 27, bottom = 174;
  const x = s => left + (right - left) * (s - xmin) / (xmax - xmin);
  const y = value => bottom - (bottom - top) * (value - low + pad) / (high - low + 2 * pad);
  chart.replaceChildren();
  if (Number.isFinite(uncoveredAfter) && xmax > uncoveredAfter) chart.append(svgElement('rect', {
    x: x(uncoveredAfter), y: top, width: right - x(uncoveredAfter), height: bottom - top, class: 'uncovered',
  }));
  chart.append(svgElement('text', {x: left, y: 16}, unit));
  const divisions = width < 400 ? 3 : 4;
  for (let i = 0; i <= divisions; i++) {
    const value = low - pad + (high - low + 2 * pad) * i / divisions;
    chart.append(svgElement('line', {x1: left, x2: right, y1: y(value), y2: y(value), class: 'grid-line'}),
      svgElement('text', {x: left - 5, y: y(value) + 4, 'text-anchor': 'end'}, measuredNumber.format(value)));
    const time = xmin + (xmax - xmin) * i / divisions;
    chart.append(svgElement('text', {x: x(time), y: bottom + 16, 'text-anchor': 'middle'}, powerFormat.format(time / 3600)));
  }
  chart.append(svgElement('text', {x: (left + right) / 2, y: 211, 'text-anchor': 'middle'}, 'Elapsed time (hours)'));
  return {x, y, top, bottom, left, right};
}

function historicalTrace(chart, samples, x, y, className) {
  const trace = samples.map((p, i) => (i ? 'L' : 'M') + x(p.elapsedS).toFixed(2) + ' ' + y(p.value).toFixed(2)).join(' ');
  chart.append(svgElement('path', {d: trace, class: className}));
}

function shippingportPlot(report, channel, wholeEvent) {
  const chart = byId('shippingport-plot');
  const duration = report.prediction.durationSeconds;
  const observedTimes = report.channels.flatMap(c => c.points.map(p => p.elapsedS));
  const xmin = wholeEvent ? Math.min(0, ...observedTimes) : 0;
  const xmax = wholeEvent ? Math.max(duration, report.milestone.observedSeconds, ...observedTimes) : duration;
  const points = channel.points.filter(p => p.elapsedS >= xmin && p.elapsedS <= xmax);
  const values = [...points.map(p => p.observed), ...channel.modelTrace.map(p => p.value)];
  const {x, y, top, bottom} = historicalAxes(chart, xmin, xmax, values, channel.unit, duration);
  chart.setAttribute('aria-label', channel.label + ' in ' + channel.unit + ', station observations and native simulation. Recorded values are available in the table below.');
  historicalTrace(chart, channel.modelTrace, x, y, 'predicted-line');
  const synchronism = report.milestone.observedSeconds;
  if (synchronism >= xmin && synchronism <= xmax) {
    chart.append(svgElement('line', {x1: x(synchronism), x2: x(synchronism), y1: top, y2: bottom, class: 'marker'}));
  }
  for (const point of points) {
    const px = x(point.elapsedS), py = y(point.observed);
    if (point.excluded) {
      chart.append(svgElement('path', {d: `M${px - 4} ${py - 4}l8 8m0 -8l-8 8`, class: 'excluded-point'}));
    } else {
      chart.append(svgElement('circle', {cx: px, cy: py, r: 3.3, class: 'observed-point'}));
    }
  }
  const legend = ['Dots show station readings. The line shows the native prediction.'];
  if (synchronism >= xmin && synchronism <= xmax) legend.push('The dashed marker shows reported turbine synchronism.');
  if (xmax > duration) legend.push('Shading begins at the end of the native run.');
  if (points.some(p => p.excluded)) legend.push('Crosses mark excluded readings.');
  byId('shippingport-caption').textContent = legend.join(' ');
}

function showShippingport(report) {
  const channel = report.channels[byId('shippingport-channel').selectedIndex];
  shippingportPlot(report, channel, byId('shippingport-window').value === 'event');
  const {scores} = channel;
  byId('shippingport-channel-note').textContent = channel.description;
  byId('shippingport-score').textContent = scores.n
    ? `Root-mean-square error ${formatValue(scores.rmse)} ${channel.unit}. Mean signed error ${formatValue(scores.bias)} ${channel.unit}. Positive error means the model predicts a higher value.`
    : 'There are no eligible observations on the model clock for this quantity.';
  byId('shippingport-count').textContent = `${scores.n} paired readings · ${channel.unpairedCount} outside shared coverage · ${channel.excludedCount} excluded.` +
    (scores.n ? ` Paired window ${hms(scores.firstElapsedS)}–${hms(scores.lastElapsedS)} elapsed.` : '');
  byId('shippingport-table-caption').textContent = `${channel.label}. All values and signed errors use ${channel.unit}. Elapsed time is hours, minutes and seconds.`;
  const body = byId('shippingport-rows');
  body.replaceChildren();
  for (const point of channel.points) {
    const tr = document.createElement('tr');
    const time = document.createElement('th');
    time.scope = 'row';
    time.textContent = point.at;
    tr.append(time);
    const outcome = point.excluded || (point.predicted === null ? 'Outside model coverage' : 'Scored');
    for (const text of [hms(point.elapsedS), formatValue(point.observed), formatValue(point.predicted), formatValue(point.error), point.page, outcome]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    body.append(tr);
  }
}

async function fetchComparison(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadShippingport() {
  try {
    const report = await fetchComparison('./shippingport-startup.json');
    if (report.schema !== 'openpwr-shippingport-startup-v1' || report.status !== 'inconclusive'
        || !Array.isArray(report.channels) || !report.channels.length || !Array.isArray(report.limitations)
        || !(report.prediction?.durationSeconds > 0) || !Number.isFinite(report.milestone?.observedSeconds)) {
      throw new Error('Unexpected Shippingport comparison format.');
    }
    const picker = byId('shippingport-channel');
    for (const channel of report.channels) {
      if (!Array.isArray(channel.points) || !Array.isArray(channel.modelTrace) || !channel.modelTrace.length
          || !channel.modelTrace.every(p => Number.isFinite(p.elapsedS) && Number.isFinite(p.value))
          || !channel.points.every(p => Number.isFinite(p.elapsedS) && Number.isFinite(p.observed))
          || !Number.isInteger(channel.scores?.n)) throw new Error('Incomplete channel observations.');
      picker.add(new Option(channel.label + ' (' + channel.unit + ')', channel.key));
    }
    byId('shippingport-scope').textContent = report.scope;
    byId('shippingport-alignment').textContent = report.alignment;
    const m = report.milestone;
    byId('shippingport-milestone').textContent = `${m.label}. Recorded at ${hms(m.observedSeconds)} elapsed.` +
      (m.breakerObserved === false ? ' The station breaker remained open.' : '') +
      (Number.isFinite(m.predictedSeconds) ? ` Model timing proxy at ${hms(m.predictedSeconds)} elapsed.` : '') +
      (Number.isFinite(m.errorSeconds) ? ` Difference (model minus recorded) ${hms(m.errorSeconds)}.` : '') + ' ' + m.note;
    for (const limitation of report.limitations) {
      const item = document.createElement('li'); item.textContent = limitation; byId('shippingport-limits').append(item);
    }
    const sourceUrl = new URL(report.source.url), runUrl = new URL(report.prediction.reportUrl);
    if (sourceUrl.protocol !== 'https:' || runUrl.protocol !== 'https:') throw new Error('Unexpected source link.');
    byId('shippingport-source').href = sourceUrl.href;
    byId('shippingport-source').textContent = report.source.title;
    byId('shippingport-native').href = runUrl.href;
    byId('shippingport-native').textContent = `Native prediction · ${report.prediction.release}`;
    picker.disabled = false;
    picker.addEventListener('change', () => showShippingport(report));
    const plotSelected = () => shippingportPlot(report, report.channels[picker.selectedIndex], byId('shippingport-window').value === 'event');
    byId('shippingport-window').addEventListener('change', plotSelected);
    byId('shippingport-results').hidden = false;
    showShippingport(report);
    // Observe the containing column; changing the SVG's viewBox should not trigger a resize loop.
    let plotWidth = 0;
    new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next && next !== plotWidth) { plotWidth = next; plotSelected(); }
    }).observe(byId('shippingport-plot').parentElement);
    status('shippingport-status', 'Whole-plant validation remains inconclusive.');
  } catch (error) {
    status('shippingport-status', 'The Shippingport comparison is unavailable. ' + error.message, true);
  }
}

void loadShippingport();

const readingRoles = {
  initialization: 'Initialization', development: 'Fit', withheldEarly: 'Early test',
  withheldLate: 'Late test', excluded: 'Excluded',
};

function developmentMark(kind, x, y) {
  if (kind.endsWith('-trace')) return svgElement('line', {x1: x - 10, x2: x + 10, y1: y, y2: y, class: kind});
  if (kind === 'test-reading') return svgElement('path', {d: `M${x} ${y - 4.5}l4.5 4.5 -4.5 4.5 -4.5 -4.5z`, class: kind});
  if (kind === 'generic-error') return svgElement('rect', {x: x - 3.4, y: y - 3.4, width: 6.8, height: 6.8, class: kind});
  if (kind === 'excluded-reading') return svgElement('path', {d: `M${x - 4} ${y - 4}l8 8m0 -8l-8 8`, class: kind});
  return svgElement('circle', {cx: x, cy: y, r: 3.4, class: kind});
}

function drawDevelopment(report, channel) {
  const residual = byId('development-view').value === 'residual';
  const showGeneric = byId('development-original').checked;
  const marks = [];
  const legend = new Map();
  const addMark = (point, value, kind, label) => {
    marks.push({point, value, kind, label});
    legend.set(kind, label);
  };
  if (!residual) {
    legend.set('historical-trace', 'Revised native');
    if (showGeneric) legend.set('generic-trace', 'Original generic');
  }
  for (const point of channel.points) {
    const withheld = point.split === 'withheldEarly' || point.split === 'withheldLate';
    if (residual) {
      if (!withheld) continue;
      if (Number.isFinite(point.predicted)) addMark(point, point.predicted - point.observed, 'historical-error', 'Revised native');
      if (showGeneric && Number.isFinite(point.generic)) addMark(point, point.generic - point.observed, 'generic-error', 'Original generic');
    } else if (point.excluded) {
      addMark(point, point.observed, 'excluded-reading', 'Source exclusion');
    } else if (withheld) {
      addMark(point, point.observed, 'test-reading', 'Withheld reading');
    } else {
      addMark(point, point.observed, 'fit-reading', 'Fit or initialization');
    }
  }
  const chart = byId('development-plot');
  const values = marks.map(m => m.value);
  if (residual) values.push(0);
  else {
    for (const point of channel.modelTrace) values.push(point.value);
    if (showGeneric) for (const point of channel.genericTrace) values.push(point.value);
  }
  const {x, y, top, bottom, left, right} = historicalAxes(chart, 0, report.durationS, values, channel.unit);
  for (const block of report.withheldBlocks) {
    chart.prepend(svgElement('rect', {x: x(block.startS), y: top, width: x(block.endS) - x(block.startS), height: bottom - top, class: 'test-interval'}));
  }
  if (residual) chart.append(svgElement('line', {x1: left, x2: right, y1: y(0), y2: y(0), class: 'zero-line'}));
  else {
    if (showGeneric) historicalTrace(chart, channel.genericTrace, x, y, 'generic-trace');
    historicalTrace(chart, channel.modelTrace, x, y, 'historical-trace');
  }
  for (const {point, value, kind, label} of marks) {
    const mark = developmentMark(kind, x(point.elapsedS), y(value));
    mark.append(svgElement('title', {}, `${point.at} · ${readingRoles[point.split]} · ${label} ${formatValue(value)} ${channel.unit}`));
    chart.append(mark);
  }
  byId('development-caption').textContent = `${channel.label} · ${channel.unit}. Shading marks the two withheld windows. ` +
    (residual ? 'Each marker gives a model error at a withheld station reading. Positive values indicate overprediction.' :
      `The original generic run ends after ${powerFormat.format(report.genericDurationS / 3600)} hours.`);
  const key = byId('development-legend');
  key.replaceChildren();
  for (const [kind, label] of legend) {
    const item = document.createElement('li');
    const symbol = svgElement('svg', {viewBox: '0 0 20 14', 'aria-hidden': 'true'});
    symbol.append(developmentMark(kind, 10, 7));
    item.append(symbol, document.createTextNode(label));
    key.append(item);
  }
}

function appendEvidenceRow(body, heading, values) {
  const row = body.insertRow();
  const th = document.createElement('th');
  th.scope = 'row';
  th.textContent = heading;
  row.append(th);
  for (const value of values) row.insertCell().textContent = value;
}

function developmentScores(channel) {
  const group = byId('development-group').value;
  const scores = group === 'common' ? channel.scores.withheld.commonGeneric : channel.scores[group];
  const body = byId('development-scores');
  body.replaceChildren();
  const estimates = [['Revised native', scores.candidate], ['Last available reading', scores.persistence]];
  if (group === 'common') estimates.splice(1, 0, ['Original generic', scores.generic]);
  for (const [label, result] of estimates) appendEvidenceRow(body, label, [result.n, formatValue(result.rmse)]);
  byId('development-score-caption').textContent = `Root-mean-square error in ${channel.unit}`;
  const n = scores.candidate.n;
  byId('development-window').textContent = group === 'development'
    ? 'Fit errors use readings available during development.'
    : group === 'common' ? 'All three estimates use the same withheld timestamps.' : 'The revised run and persistence use the same withheld timestamps.';
  if (n === 0) byId('development-window').append(' This channel has no readings in this selection.');
  const all = channel.scores.withheld.candidate;
  byId('development-coverage').textContent = group === 'withheld'
    ? 'Persistence carries the last initialization or fit reading forward throughout each test window.'
    : `Across both withheld windows, RMSE is ${formatValue(all.rmse)} ${channel.unit} for the revised model and ${formatValue(channel.scores.withheld.persistence.rmse)} ${channel.unit} for carrying forward the last available reading (${all.n} readings).`;
}

function developmentRows(channel) {
  byId('development-table-caption').textContent = `${channel.label} · ${channel.unit}. A dash marks an unavailable prediction or an excluded error.`;
  const body = byId('development-rows');
  body.replaceChildren();
  for (const p of channel.points) {
    const error = value => Number.isFinite(value) && !p.excluded ? formatValue(value - p.observed) : '—';
    appendEvidenceRow(body, p.at.replace('T', ' '), [readingRoles[p.split], formatValue(p.observed), formatValue(p.predicted), error(p.predicted), error(p.generic), p.page]);
  }
}

async function loadDevelopment() {
  try {
    const report = await fetchComparison('./shippingport-development.json');
    if (report.schema !== 'openpwr-shippingport-development-v1' || !(report.durationS > 0) ||
        !Array.isArray(report.channels) || !report.channels.length || !Array.isArray(report.withheldBlocks)) {
      throw new Error('Unexpected historical model report.');
    }
    const picker = byId('development-channel');
    for (const channel of report.channels) picker.add(new Option(channel.label + ' (' + channel.unit + ')', channel.key));
    const channel = () => report.channels[picker.selectedIndex];
    const update = () => {
      drawDevelopment(report, channel());
      developmentRows(channel());
      developmentScores(channel());
    };
    byId('development-limits').textContent = report.limitations.join(' ');
    const stationClock = timestamp => timestamp.slice(8, 10) + ' June at ' + timestamp.slice(11);
    const windows = report.withheldBlocks.map(block => stationClock(block.start) + '–' + block.end.slice(11));
    byId('development-split-note').textContent = `The revised native case uses measurements from the 1958 Shippingport startup. The reserved test windows were ${windows.join(' and ')} (station time).`;
    picker.addEventListener('change', update);
    byId('development-group').addEventListener('change', () => developmentScores(channel()));
    byId('development-view').addEventListener('change', () => drawDevelopment(report, channel()));
    byId('development-original').addEventListener('change', () => drawDevelopment(report, channel()));
    byId('development-results').hidden = false;
    update();
    let plotWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width && width !== plotWidth) { plotWidth = width; drawDevelopment(report, channel()); }
    }).observe(byId('development-plot').parentElement);
    const comparisons = report.channels.filter(c => c.scores.withheld.commonGeneric.candidate.n).map(c => {
      const {candidate, generic} = c.scores.withheld.commonGeneric;
      return `from ${formatValue(generic.rmse)} to ${formatValue(candidate.rmse)} ${c.unit} for ${c.label.toLowerCase()} (${candidate.n} ${candidate.n === 1 ? 'reading' : 'readings'})`;
    });
    const persistenceWins = report.channels.filter(c => c.scores.withheld.persistence.rmse < c.scores.withheld.candidate.rmse);
    const conclusion = persistenceWins.length === report.channels.length
      ? 'Across both test windows, carrying forward the last available reading gave lower RMSE for both quantities.'
      : 'The full-window comparison below also scores the last available reading as a predictor.';
    const comparison = comparisons.length
      ? 'Compared with the original generic run, early withheld RMSE changed ' + comparisons.join(' and ') + '.'
      : 'The original run covers no withheld readings.';
    status('development-status', comparison + ' ' + conclusion);
  } catch (error) {
    byId('development-results').hidden = true;
    status('development-status', 'The historical model comparison is unavailable. ' + error.message, true);
  }
}

void loadDevelopment();

function transferPlot(channel) {
  const chart = byId('transfer-chart');
  const points = channel.points;
  if (!points.length) {
    chart.replaceChildren();
    byId('transfer-caption').textContent = 'No measured target times in this window.';
    return;
  }
  const times = points.map(p => p.targetS);
  const start = Math.min(...points.map(p => p.originS), ...times);
  const end = Math.max(start + 1, ...times);
  const values = points.flatMap(p => [p.forecast, p.persistence, p.observed]);
  const {x, y} = historicalAxes(chart, start, end, values, channel.unit);
  for (const p of points) {
    const tx = x(p.targetS), fy = y(p.forecast);
    const observed = svgElement('circle', {cx: tx, cy: y(p.observed), r: 4.2, class: 'observed-point'});
    const baseline = svgElement('rect', {x: tx - 3.6, y: y(p.persistence) - 3.6, width: 7.2, height: 7.2, class: 'persistence-mark'});
    const forecast = svgElement('path', {d: 'M ' + tx + ' ' + (fy - 3.3) + ' l 3.3 3.3 -3.3 3.3 -3.3 -3.3 Z', class: 'forecast-mark'});
    chart.append(observed, baseline, forecast);
  }
  byId('transfer-caption').textContent = channel.label + ' at ' + points.length + ' measured target times. The table below gives the forecast origin for each prediction.';
}

function transferReadings(channel) {
  const unit = channel.unit;
  const candidate = channel.candidate.rmse;
  const persistence = channel.persistence.rmse;
  const change = Number.isFinite(channel.rmseReductionPct) && channel.rmseReductionPct !== 0
    ? ' (' + formatValue(Math.abs(channel.rmseReductionPct)) + '% ' + (candidate < persistence ? 'lower' : 'higher') + ')' : '';
  const count = channel.n + (channel.n === 1 ? ' reading' : ' readings');
  byId('transfer-score').textContent = candidate === persistence
    ? 'Both forecasts had the same RMSE of ' + formatValue(candidate) + ' ' + unit + ' across ' + count + '.'
    : 'Across ' + count + ', forecast RMSE was ' + formatValue(candidate) + ' ' + unit + change + ' and last-reading RMSE was '
      + formatValue(persistence) + ' ' + unit + '.';
  const range = channel.deleteOneRmseAdvantageRange;
  byId('transfer-sensitivity').textContent = Array.isArray(range)
    ? 'Removing one target at a time gives a last-reading minus forecast RMSE of ' + formatValue(range[0]) + ' to '
      + formatValue(range[1]) + ' ' + unit + '. Positive values favor the forecast.' : '';
  byId('transfer-point-caption').textContent = channel.label + ' (' + unit + '). Times are hours:minutes:seconds from the event origin.';
  const rows = byId('transfer-points');
  rows.replaceChildren();
  for (const p of channel.points) {
    appendEvidenceRow(rows, hms(p.originS), [hms(p.targetS), formatValue(p.observed), formatValue(p.forecast),
      formatValue(p.persistence), formatValue(p.forecast - p.observed)]);
  }
}

async function loadTransfer() {
  try {
    const report = await fetchComparison('./startup-transfer.json');
    if (report.schema !== 'openpwr-startup-transfer-v1' || !report.events?.length) throw new Error('Unexpected forecast record.');
    const primary = byId('transfer-primary');
    let improved = 0, total = 0;
    const eventSelect = byId('transfer-event'), groupSelect = byId('transfer-group'), channelSelect = byId('transfer-channel');
    for (const event of report.events) {
      eventSelect.add(new Option(event.label, event.id));
      for (const group of event.groups.filter(g => g.primary)) {
        for (const channel of group.channels) {
          total++;
          if (channel.improved) improved++;
          appendEvidenceRow(primary, event.label + ' · ' + group.label, [channel.label, channel.n,
            formatValue(channel.candidate.rmse) + ' ' + channel.unit, formatValue(channel.persistence.rmse) + ' ' + channel.unit]);
        }
      }
    }
    if (!total) throw new Error('No primary comparisons found.');
    let finding = 'The forecast had lower error than carrying the last reading forward on ' + improved + ' of ' + total + ' primary comparisons.';
    const historical = report.events.find(e => e.id === 'shippingport');
    const earlyTemp = historical?.groups.find(g => g.id === 'reservedEarly')?.channels.find(c => c.id === 'averageCoolantTemperature');
    const late = historical?.groups.find(g => g.id === 'reservedLate');
    if (earlyTemp?.n === 1 && earlyTemp.improved && late?.channels.every(c => c.candidate.rmse === c.persistence.rmse)) {
      finding += ' The Shippingport temperature gain comes from one early reading. Both channels tied in the late window.';
    }
    status('transfer-status', finding);
    byId('transfer-scope').textContent = 'The forecast extends the latest measured trend and lets its rate decay with time. With one reading available, the native model supplies the initial rate. ' + report.scope;
    byId('transfer-protocol').href = 'https://github.com/ajayasai/OpenPWR/blob/' + report.protocolRevision + '/validation/startup_transfer/protocol.json';
    byId('transfer-results').hidden = false;
    const activeEvent = () => report.events.find(e => e.id === eventSelect.value);
    const activeGroup = () => activeEvent().groups.find(g => g.id === groupSelect.value);
    const activeChannel = () => activeGroup().channels.find(c => c.id === channelSelect.value);
    function showChannel() {
      transferPlot(activeChannel());
      transferReadings(activeChannel());
    }
    function showGroup() {
      const previous = channelSelect.value;
      channelSelect.replaceChildren(...activeGroup().channels.map(c => new Option(c.label, c.id)));
      if (activeGroup().channels.some(c => c.id === previous)) channelSelect.value = previous;
      showChannel();
    }
    function showEvent() {
      const event = activeEvent();
      byId('transfer-description').textContent = event.description;
      byId('transfer-source').href = event.sourceUrl;
      groupSelect.replaceChildren(...event.groups.map(g => new Option(g.label, g.id)));
      groupSelect.value = (event.groups.find(g => g.primary) || event.groups[0]).id;
      showGroup();
    }
    eventSelect.addEventListener('change', showEvent);
    groupSelect.addEventListener('change', showGroup);
    channelSelect.addEventListener('change', showChannel);
    showEvent();
    new ResizeObserver(() => transferPlot(activeChannel())).observe(byId('transfer-chart'));
  } catch (error) {
    byId('transfer-results').hidden = true;
    status('transfer-status', 'The startup forecast comparison is unavailable. ' + error.message, true);
  }
}

void loadTransfer();
