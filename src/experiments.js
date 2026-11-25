// SPDX-License-Identifier: Apache-2.0
import { PWRPlant } from './engine.js';
import { PAIRED_METRICS, pairedRunCsv, runPairedExperiment, validatePairedRecipe } from './paired-run.js';

const element = id => document.getElementById(id);
const svg = element('trace');
const metric = element('metric');
const cursor = element('cursor');
const settings = element('settings');
const demandInput = element('demand');
const durationInput = element('duration');
const displayNumber = (value, digits) => value.toLocaleString('en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});
const seconds = value => Number(value.toFixed(2)).toLocaleString('en-US') + ' s';
const percent = fraction => Number((fraction * 100).toFixed(5)) + '%';
let checkpoint, result, active, geometry, importedDemand;
let importTicket = 0;

for (const [key, info] of Object.entries(PAIRED_METRICS)) {
  metric.add(new Option(info.label, key));
}
metric.value = 'electricPower';

function status(message, error = false) {
  element('run-status').textContent = message;
  element('run-status').toggleAttribute('data-error', error);
}

function activateState(model, source) {
  const verifier = new PWRPlant();
  const initial = verifier.importState(model);
  checkpoint = verifier.exportState();
  element('start-source').textContent = source;
  element('start-clock').textContent = seconds(initial.time);
  element('start-output').textContent = displayNumber(initial.electricPower, 1) + ' MWe';
  element('start-demand').textContent = percent(initial.controls.demand);
  element('feedwater-law').textContent = checkpoint.schema === 'openpwr-state-v2'
    ? 'Saturation curve (v2)' : 'Pressure-dependent (v3)';
  for (const [id, field] of [['reactor-mode', 'autoReactor'], ['turbine-mode', 'autoTurbine'], ['feedwater-mode', 'autoFeedwater']]) {
    element(id).textContent = initial.controls[field] ? 'Automatic' : 'Manual';
  }
  element('reset-start').hidden = source === 'Full-power equilibrium';
  element('settings-fields').disabled = false;
}

function clearResult() {
  result = undefined;
  geometry = undefined;
  svg.replaceChildren();
  svg.setAttribute('aria-label', 'Awaiting a paired run');
  metric.disabled = cursor.disabled = true;
  element('export-csv').disabled = element('export-recipe').disabled = true;
  element('cursor-label').textContent = '—';
  document.querySelectorAll('[data-reading]').forEach(item => { item.textContent = '—'; });
  element('run-event').hidden = true;
  element('run-summary').textContent = 'Awaiting a paired run';
}

function busy(running) {
  element('settings-fields').disabled = running || !checkpoint;
  element('cancel-pair').hidden = !running;
  element('run-progress').hidden = !running;
  element('open-recipe').disabled = running;
}

async function compare(options) {
  const controller = new AbortController();
  active?.abort();
  active = controller;
  clearResult();
  busy(true);
  element('run-progress').value = 0;
  status('Calculating both runs…');
  try {
    const next = await runPairedExperiment(checkpoint, options, {
      signal: controller.signal,
      onProgress: fraction => { if (active === controller) element('run-progress').value = fraction; },
    });
    if (active !== controller || controller.signal.aborted) return;
    result = next;
    cursor.max = String(next.rows.length - 1);
    cursor.value = cursor.max;
    metric.disabled = false;
    cursor.disabled = next.rows.length < 2;
    element('export-csv').disabled = element('export-recipe').disabled = false;
    element('run-summary').textContent = percent(next.baselineDemand) + ' original · ' + percent(next.demand)
      + ' changed · ' + seconds(next.durationS) + ' requested';
    const notices = [];
    if (!next.complete) notices.push('Model boundary at ' + seconds(next.stopElapsedS) + '. ' + next.stopReason
      + '. Last shared valid reading at ' + seconds(next.elapsedS) + '.');
    for (const [name, trip] of [['Original run', next.baselineTrip], ['Changed run', next.alternativeTrip]]) {
      if (trip) notices.push(name + ' tripped at ' + seconds(trip.elapsedS) + ' (' + trip.reason + ').');
    }
    element('run-event').textContent = notices.join(' ');
    element('run-event').hidden = !notices.length;
    status(next.complete ? 'Completed both runs through ' + seconds(next.elapsedS) + '.'
      : 'Comparison stopped at the model boundary.');
    drawChart();
  } catch (error) {
    if (active !== controller) return;
    if (controller.signal.aborted) status('Run canceled.');
    else status(error.message, true);
  } finally {
    if (active === controller) {
      active = undefined;
      busy(false);
      if (controller.signal.aborted) status('Run canceled.');
    }
  }
}

function svgNode(name, attributes, parent = svg, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, val] of Object.entries(attributes)) node.setAttribute(key, val);
  if (content !== undefined) node.textContent = content;
  parent.append(node);
  return node;
}

function drawChart() {
  if (!result) return;
  svg.replaceChildren();
  const rows = result.rows;
  const width = Math.max(180, Math.round(svg.getBoundingClientRect().width));
  const height = Math.max(160, Math.round(svg.getBoundingClientRect().height));
  const key = metric.value;
  const info = PAIRED_METRICS[key];
  const left = width < 400 ? 58 : 67, right = width - 17;
  const top = 26, bottom = height - 46;
  let low = Infinity, high = -Infinity;
  for (const row of rows) {
    low = Math.min(low, row.baseline[key], row.alternative[key]);
    high = Math.max(high, row.baseline[key], row.alternative[key]);
  }
  const mid = (low + high) / 2;
  const pressure = info.unit === 'MPa';
  const span = Math.max((high - low) * 1.15, pressure ? 0.02 : 2, Math.abs(mid) * 0.005);
  const y = value => bottom - (value - mid + span / 2) / span * (bottom - top);
  const x = time => left + (result.elapsedS ? time / result.elapsedS : 0) * (right - left);
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('aria-label', info.label + ' over ' + seconds(result.elapsedS) + '. Use the time slider to inspect both curves.');
  const line = (x1, y1, x2, y2, style) => svgNode('line', { x1, y1, x2, y2, class: style });
  const label = (x, y, value, align, style = '') => svgNode('text', { x, y, class: style, 'text-anchor': align }, svg, value);
  label(left, 13, info.unit, 'start', 'axis-title');
  for (let tick = 0; tick <= 4; tick++) {
    const value = mid + span * (tick / 4 - 0.5);
    line(left, y(value), right, y(value), 'chart-grid');
    const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(span / 4)) + 1));
    label(left - 6, y(value) + 4, displayNumber(value, decimals), 'end');
  }
  const intervals = result.elapsedS ? (width < 450 ? 2 : 4) : 0;
  for (let tick = 0; tick <= intervals; tick++) {
    const time = intervals ? result.elapsedS * tick / intervals : 0;
    line(x(time), top, x(time), bottom, 'chart-grid');
    label(x(time), bottom + 17, Number(time.toFixed(2)).toLocaleString('en-US'), 'middle');
  }
  label((left + right) / 2, height - 6, 'Elapsed time (s)', 'middle', 'axis-title');
  for (const [field, style] of [['alternative', 'changed-line'], ['baseline', 'baseline-line']]) {
    const d = rows.map((row, i) => (i ? 'L' : 'M') + x(row.elapsedS).toFixed(2) + ' ' + y(row[field][key]).toFixed(2)).join(' ');
    svgNode('path', { d, class: 'series ' + style });
  }
  const indicator = svgNode('g', {});
  geometry = { x, y, left, right, top, bottom, indicator };
  showCursor();
}

function showCursor() {
  if (!result || !geometry) return;
  const row = result.rows[Number(cursor.value)];
  const { x, y, top, bottom, indicator } = geometry;
  const key = metric.value, info = PAIRED_METRICS[key];
  const digits = info.unit === 'MPa' ? 3 : 1;
  element('cursor-label').textContent = seconds(row.elapsedS);
  cursor.setAttribute('aria-valuetext', seconds(row.elapsedS));
  const cx = x(row.elapsedS);
  indicator.replaceChildren();
  svgNode('line', { x1: cx, x2: cx, y1: top, y2: bottom, class: 'cursor-line' }, indicator);
  svgNode('circle', { cx, cy: y(row.alternative[key]), r: 5, class: 'cursor-point changed-dot' }, indicator);
  svgNode('circle', { cx, cy: y(row.baseline[key]), r: 2.8, class: 'cursor-point baseline-dot' }, indicator);
  for (const reading of document.querySelectorAll('[data-reading]')) {
    const field = reading.dataset.reading;
    const rounded = Number(row[field][key].toFixed(digits)) || 0;
    const sign = field === 'delta' && rounded > 0 ? '+' : '';
    reading.textContent = sign + displayNumber(rounded, digits) + ' ' + info.unit;
  }
}

svg.addEventListener('click', event => {
  if (!result || !geometry) return;
  const { left, right } = geometry;
  const targetTime = (event.clientX - svg.getBoundingClientRect().left - left) / (right - left) * result.elapsedS;
  let nearest = 0;
  result.rows.forEach((row, i, rows) => {
    if (Math.abs(row.elapsedS - targetTime) < Math.abs(rows[nearest].elapsedS - targetTime)) nearest = i;
  });
  cursor.value = nearest;
  showCursor();
});
new ResizeObserver(drawChart).observe(svg);
metric.addEventListener('change', drawChart);
cursor.addEventListener('input', showCursor);
settings.addEventListener('input', () => { if (result) status('Settings changed. Run comparison to apply them.'); });
settings.addEventListener('submit', event => {
  event.preventDefault();
  const demand = importedDemand && demandInput.value === importedDemand.display ? importedDemand.exact : demandInput.valueAsNumber / 100;
  compare({ demand, durationS: durationInput.valueAsNumber });
});
element('cancel-pair').addEventListener('click', () => active?.abort());

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
element('export-csv').addEventListener('click', () => {
  if (result) download('openpwr-paired-trace.csv', pairedRunCsv(result), 'text/csv;charset=utf-8');
});
element('export-recipe').addEventListener('click', () => {
  if (result) download('openpwr-paired-recipe.json', JSON.stringify(result.recipe, null, 2) + '\n', 'application/json');
});
element('open-recipe').addEventListener('click', () => element('import-recipe').click());
element('import-recipe').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const ticket = ++importTicket;
  const errorBox = element('recipe-error');
  errorBox.hidden = true;
  try {
    if (file.size > 5_000_000) throw new Error('Choose a recipe file of at most 5 MB.');
    const contents = await file.text();
    if (ticket !== importTicket) return;
    const recipe = validatePairedRecipe(JSON.parse(contents));
    activateState(recipe.model, 'Saved experiment recipe');
    demandInput.value = String(recipe.demand * 100);
    durationInput.value = recipe.durationS;
    importedDemand = { exact: recipe.demand, display: demandInput.value };
    await compare({ demand: recipe.demand, durationS: recipe.durationS });
  } catch (error) {
    if (ticket !== importTicket) return;
    errorBox.textContent = 'Could not open recipe. ' + error.message;
    errorBox.hidden = false;
  }
});

try {
  if (new URLSearchParams(location.search).get('from') === 'control-room') {
    element('start-source').textContent = 'Control-room capture unavailable';
    element('reset-start').hidden = false;
    const raw = sessionStorage.getItem('openpwr-paired-start-v1');
    if (!raw) throw new Error('This tab has no captured starting state. Open a new comparison from the control room or choose the full-power equilibrium.');
    activateState(JSON.parse(raw), 'Captured control-room state');
  } else {
    activateState(new PWRPlant().exportState(), 'Full-power equilibrium');
  }
  compare({ demand: demandInput.valueAsNumber / 100, durationS: durationInput.valueAsNumber });
} catch (error) {
  status(error.message, true);
}
