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
