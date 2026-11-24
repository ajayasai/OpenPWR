// SPDX-License-Identifier: Apache-2.0
import { alignedObservations, observationsCsv, pressureSchemas } from './aligned-observations.js';
const $ = id => document.getElementById(id);
const make = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const format = value => typeof value === 'number' ? Number.isFinite(value) ? (value !== 0 && Math.abs(value) < .001 ? value.toExponential(3) : value.toLocaleString('en-US', { maximumSignificantDigits: 6 })) : '—' : String(value ?? '—');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase()).replace(/Rmse/g, 'RMSE');
const describe = value => Array.isArray(value) ? value.map(describe).join('; ') : value && typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${label(key)}: ${describe(item)}`).join('; ') : format(value);
function definition(target, name, value) { target.append(make('dt', name), make('dd', format(value))); }
async function readView(path) {
  const file = path.slice(2);
  const response = await fetch(path.replace(/\.json$/, '.view.json'), { cache: 'no-store' });
  if (response.status === 404) {
    const raw = await fetch(path, { cache: 'no-store' });
    if (!raw.ok) throw new Error(`Evidence unavailable (HTTP ${raw.status}). Generate the current native reports before publishing.`);
    return { report: await raw.json() };
  }
  if (!response.ok) throw new Error(`Evidence view unavailable (HTTP ${response.status}).`);
  const view = await response.json();
  if (view?.schema !== 'openpwr-evidence-view-v1' || view.source?.file !== file
      || !Number.isSafeInteger(view.source.bytes) || view.source.bytes <= 0 || !hash(view.source.sha256)
      || !view.report || typeof view.report !== 'object') throw new Error('The evidence view has an incomplete source identity.');
  return view;
}
async function nativeEvidence() {
  try {
    const { report } = await readView('./plant-verification.json');
    if (report.runtime?.model !== 'OpenPWR.CoupledPlant' || !hash(report.runtime.fmuSha256)
        || !hash(report.buildManifest?.sourceSha256) || !Array.isArray(report.checks) || !report.checks.length
        || report.total !== report.checks.length || report.passed !== report.checks.filter(item => item.pass === true).length
        || report.checks.some(item => typeof item.name !== 'string' || typeof item.pass !== 'boolean')) throw new Error('Native report identity or check totals are inconsistent.');
    $('plant-status').textContent = `${report.passed}/${report.total} numerical checks passed · v${report.version}`;
    const identity = $('plant-identity');
    definition(identity, 'Model', report.runtime.model); definition(identity, 'Source revision', report.gitRevision);
    definition(identity, 'FMU SHA-256', report.runtime.fmuSha256); definition(identity, 'Model source SHA-256', report.buildManifest.sourceSha256);
    definition(identity, 'Working tree', report.gitDirty ? 'Modified when tested' : 'Clean when tested');
    for (const check of report.checks) {
      const article = make('details', undefined, 'native-check');
      const summary = make('summary');
      summary.append(make('span', check.pass ? 'PASS' : 'FAIL', `result ${check.pass ? 'pass' : 'fail'}`), make('span', check.name, 'check-title'));
      article.append(summary);
      if (!check.pass) article.open = true;
      const evidence = check.evidence || Object.fromEntries(Object.entries(check).filter(([key]) => !['name', 'pass'].includes(key)));
      const list = make('dl'); for (const [key, value] of Object.entries(evidence)) definition(list, label(key), describe(value));
      article.append(list); $('plant-checks').append(article);
    }
  } catch (error) { $('plant-status').textContent = error.message; }
}
let measured = null;
let evidenceRequest = 0;
// Cases can share a large immutable evidence file; reuse it while this page is open.
const measuredReports = new Map();
function readMeasured(path) {
  if (!measuredReports.has(path)) measuredReports.set(path, readView(path).catch(error => {
    measuredReports.delete(path); throw error;
  }));
  return measuredReports.get(path);
}
const casePaths = { 'pressure-spray': './krsko-pressure-development.json', pressure: './krsko-pressure-development.json', continuous: './continuous-measured-validation.json', krsko: './measured-validation.json', pactel: './pressurizer-validation.json', 'pactel-holdout': './pressurizer-validation.json' };
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes, text) {
  const el = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text; return el;
}
let observations;
let observationPage = 0;
const pageSize = 12;
const signed = value => (value > 0 ? '+' : '') + value.toFixed(6);

function renderObservationPage() {
  const view = observations;
  const first = observationPage * pageSize, end = Math.min(first + pageSize, view.rows.length);
  const head = $('observations-head'), body = $('observations-rows');
  head.replaceChildren(); body.replaceChildren();
  const cols = [{ key: 'time', title: 'Time (s)' }, { key: 'measured', title: 'Measured' }];
  for (const { key, label: title } of view.series) {
    cols.push({ key, title }, { key: key + 'Error', title: title + ' error', signed: true });
  }
  if (view.graphical) cols.push({ key: 'lowerAllowance', title: 'Lower allowance' }, { key: 'upperAllowance', title: 'Upper allowance' });
  if (view.special) cols.push({ key: 'closer', title: 'Closer of candidate / released' });
  for (const col of cols) {
    const th = make('th', col.title); th.scope = 'col'; head.append(th);
  }
  for (const row of view.rows.slice(first, end)) {
    const tr = make('tr');
    for (const col of cols) {
      const value = row[col.key];
      if (col.key === 'time') {
        const th = make('th', value); th.scope = 'row'; tr.append(th);
      } else tr.append(make('td', typeof value === 'number' ? (col.signed ? signed(value) : value.toFixed(6)) : value));
    }
    body.append(tr);
  }
  $('observations-pages').hidden = view.rows.length <= pageSize;
  $('observations-jump').value = String(observationPage);
  $('observations-page').textContent = `Rows ${first + 1}–${end} of ${view.rows.length}`;
  $('observations-prev').disabled = first === 0;
  $('observations-next').disabled = end === view.rows.length;
}
function inspectObservations(channel) {
  observations = null;
  observationPage = 0;
  $('aligned-observations').hidden = !channel;
  $('observations-csv').disabled = true;
  $('observations-scroll').hidden = $('observations-note').hidden = $('observations-pages').hidden = true;
  $('observations-rows').replaceChildren();
  if (!channel) return;
  $('observations-title').textContent = channel.name + ' at scored times';
  try {
    observations = alignedObservations(measured, channel);
    const v = observations;
    $('observations-title').textContent = channel.name + (v.graphical ? ' on the graphical grid' : ' at acquired times');
    const score = (key, name) => `${name} RMSE ${v.scores[key].rmse.toFixed(6)} ${v.unit}, mean signed error ${signed(v.scores[key].bias)} ${v.unit}.`;
    const scores = v.series.filter(s => ['baseline', 'simulated'].includes(s.key)).map(s => score(s.key, s.label));
    $('observations-score').textContent = `${v.rows.length} ${v.graphical ? 'correlated graphical positions' : 'acquired samples'}. ${scores.join(' ')}`;
    $('observations-caption').textContent = v.graphical
      ? `${channel.name}. Readings, conditional allowances and signed errors use ${v.unit}.`
      : `${channel.name}. Readings and signed errors use ${v.unit}.`;
    const notes = ['Signed error is predicted minus measured. The CSV includes every scored row at the precision of the report.'];
    notes.push(v.graphical ? 'Each position is read on a one-second grid from the published curve. The lower and upper allowances combine reported instrument, figure-reading and timing bounds.'
      : 'The measured reference at 0 s is interpolated and excluded. The displayed decimals preserve the digitized data for checking the calculation.');
    if (v.special) notes.push('The closer model has the smaller absolute error before rounding. A tie indicates equality within numerical roundoff.');
    $('observations-note').textContent = notes.join(' ');
    const jump = $('observations-jump');
    jump.replaceChildren();
    for (let i = 0; i < v.rows.length; i += pageSize) {
      const last = Math.min(v.rows.length, i + pageSize) - 1;
      jump.add(new Option(v.rows[i].time + '–' + v.rows[last].time + ' s', String(i / pageSize)));
    }
    renderObservationPage();
    $('observations-csv').disabled = $('observations-note').hidden = $('observations-scroll').hidden = false;
  } catch (error) {
    observations = null;
    $('observations-score').textContent = 'Sample comparison unavailable. ' + error.message;
  }
}
function moveToObservationPage(page) {
  if (!observations || page < 0 || page * pageSize >= observations.rows.length) return;
  observationPage = page;
  renderObservationPage();
}
$('observations-jump').addEventListener('change', () => moveToObservationPage($('observations-jump').selectedIndex));
$('observations-prev').addEventListener('click', () => moveToObservationPage(observationPage - 1));
$('observations-next').addEventListener('click', () => moveToObservationPage(observationPage + 1));
$('observations-csv').addEventListener('click', () => {
  if (!observations) return;
  const url = URL.createObjectURL(new Blob([observationsCsv(observations)], { type: 'text/csv;charset=utf-8' }));
  const link = make('a'); link.href = url;
  link.download = 'openpwr-' + $('measured-case').value + '-' + observations.channel + '.csv';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function drawComparison() {
  const chart = $('measured-chart'); chart.replaceChildren(); $('measurement-metrics').replaceChildren();
  const channel = measured?.channels.find(item => item.name === $('measured-channel').value);
  inspectObservations(channel);
  const points = channel?.points?.filter(item => Number.isFinite(item.time)) || [];
  if (!points.length) { chart.append(svg('text', { x: 450, y: 165, fill: '#91acb8', 'text-anchor': 'middle' }, 'No measured comparison available')); return; }
  const contrastKey = measured.schema === 'openpwr-krsko-pressure-spray-development-v1' ? 'originalNoSpray' : 'noWall';
  const values = points.flatMap(point => [point.measured, point.simulated, point.baseline, point[contrastKey], point.lowerAllowance, point.upperAllowance]).filter(Number.isFinite);
  if (!values.length) return;
  const times = points.map(point => point.time), begin = Math.min(...times), end = Math.max(...times);
  let min = Math.min(...values), max = Math.max(...values); const margin = Math.max(max - min, .001, Math.abs(max) * .00001) * .12;
  min -= margin; max += margin;
  const x = time => 92 + (time - begin) / Math.max(end - begin, .1) * 780;
  const y = value => 277 - (value - min) / (max - min) * 245;
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4, time = begin + (end - begin) * i / 4;
    chart.append(svg('path', { d: `M92 ${y(value)} H872`, stroke: '#29404c', fill: 'none' }), svg('text', { x: 81, y: y(value) + 4, fill: '#93abb7', 'text-anchor': 'end', 'font-size': 12 }, format(value)), svg('text', { x: x(time), y: 305, fill: '#93abb7', 'text-anchor': 'middle', 'font-size': 12 }, `${format(time)} s`));
  }
  const hasBaseline = points.some(point => Number.isFinite(point.baseline));
  $('baseline-legend').hidden = !hasBaseline;
  $('baseline-legend').replaceChildren(make('i', undefined, 'baseline-key'), document.createTextNode(measured.releasedBaseline?.version ? `Released v${measured.releasedBaseline.version}` : 'Released v0.5 baseline'));
  $('simulated-legend').replaceChildren(make('i', undefined, 'simulated-key'), document.createTextNode(measured.schema === 'openpwr-krsko-pressure-spray-development-v1' ? 'Conditional spray model' : measured.schema === 'openpwr-krsko-pressure-development-v1' ? 'Finite-phase model with wall' : 'Native model'));
  $('no-wall-legend').hidden = !points.some(point => Number.isFinite(point[contrastKey]));
  $('no-wall-legend').replaceChildren(make('i', undefined, 'no-wall-key'), document.createTextNode(contrastKey === 'originalNoSpray' ? 'Same model without spray' : 'Same model without wall heat transfer'));
  const scoredTimes = new Set(observations?.rows.map(row => row.time));
  $('measured-legend').replaceChildren(make('i', undefined, 'measured-key'), document.createTextNode(observations?.graphical ? 'Digitized pressure curve' : 'Digitized plant readings'));
  const bounded = points.filter(point => Number.isFinite(point.lowerAllowance) && Number.isFinite(point.upperAllowance));
  if (bounded.length) {
    const polygon = [...bounded.map(point => `${x(point.time)},${y(point.upperAllowance)}`), ...bounded.slice().reverse().map(point => `${x(point.time)},${y(point.lowerAllowance)}`)].join(' ');
    chart.append(svg('polygon', { points: polygon, fill: '#ecb3db', opacity: .10 }));
  }
  for (const [key, color] of [[contrastKey, '#e5b46f'], ['baseline', '#81929d'], ['measured', '#ecb3db'], ['simulated', '#86dfd0']]) {
    let path = '', previous = false;
    for (const [index, point] of points.entries()) {
      if (!Number.isFinite(point[key])) { previous = false; continue; }
      path += `${previous ? ' L' : ' M'}${x(point.time)} ${y(point[key])}`; previous = true;
      if (key === 'measured' && scoredTimes.has(point.time)
          && (points.length < 100 || index % 10 === 0 || index === points.length - 1)) chart.append(svg('circle', { cx: x(point.time), cy: y(point[key]), r: 2.8, fill: color }));
    }
    chart.append(svg('path', { d: path, stroke: color, fill: 'none', 'stroke-width': 2, 'stroke-dasharray': key === 'baseline' ? '6 5' : key === contrastKey ? '2 4' : 'none', 'stroke-linejoin': 'round' }));
  }
  const timing = observations?.graphical
    ? 'Dots mark selected positions on the digitized curve. Shading shows the conditional allowance from reading, timing and instrument bounds.'
    : 'Dots mark acquired readings. The measured value at 0 s is interpolated and excluded from scoring.';
  chart.setAttribute('aria-label', channel.name + ' in ' + channel.unit + ' versus time in seconds.');
  $('measured-caption').textContent = `${channel.label || channel.name} · ${channel.unit}. ${channel.description || 'Published measurements compared with the boundary-driven native model.'} ${observations ? timing : ''}`;
  for (const [key, value] of Object.entries(channel.metrics || {})) {
    if (observations && ['samples', 'rmse', 'releasedBaselineRmse', 'v07BaselineRmse', 'meanError'].includes(key)) continue;
    const article = make('article'); article.append(make('span', label(key)), make('strong', format(value))); $('measurement-metrics').append(article);
  }
}
async function measuredEvidence() {
  const request = ++evidenceRequest;
  const path = casePaths[$('measured-case').value] || casePaths.krsko;
  measured = null;
  for (const id of ['measured-scope', 'measured-identity', 'measurement-links', 'measurement-assumptions', 'measured-channel', 'measurement-numerics']) $(id).replaceChildren();
  $('measured-channel').disabled = true;
  $('measured-status').dataset.status = 'loading';
  $('measured-status').textContent = 'Loading measured comparison…';
  $('measured-caption').textContent = 'Awaiting recorded comparison.';
  $('measured-report-link').href = path;
  $('baseline-legend').hidden = true;
  $('no-wall-legend').hidden = true;
  drawComparison();
  try {
    const { report: parent, source } = await readMeasured(path);
    const chosen = $('measured-case').value;
    const report = chosen === 'pactel-holdout' ? parent.holdoutComparison : chosen === 'pressure-spray' ?
      (parent.conditionalSpray ? {...parent, ...parent.conditionalSpray, schema:'openpwr-krsko-pressure-spray-development-v1'} : null) : parent;
    if (request !== evidenceRequest) return;
    if (!report) throw new Error('The selected development comparison is not available in this build.');
    if (report.executed !== true) throw new Error(`Comparison did not complete. ${report.error || 'Read the saved report for diagnostics.'}`);
    if (!['openpwr-measured-validation-v1', 'openpwr-continuous-measured-v1', 'openpwr-krsko-pressure-development-v1','openpwr-krsko-pressure-spray-development-v1'].includes(report.schema) || !Array.isArray(report.channels) || !report.channels.length || report.channels.length > 30
        || !hash(report.runtime?.fmuSha256) || !hash(report.inputDataSha256)
        || report.channels.some(channel => typeof channel.name !== 'string' || !Array.isArray(channel.points) || channel.points.length > 10000)) throw new Error('Measured report provenance or channel schema is incomplete.');
    measured = report;
    const numericalPass = report.numericalPassed === true && Array.isArray(report.numericalChecks) && report.numericalChecks.length > 0 && report.numericalChecks.every(check => check.pass === true && Number.isFinite(check.value) && Number.isFinite(check.absoluteTolerance) && check.absoluteTolerance >= 0 && Math.abs(check.value) <= check.absoluteTolerance);
    $('measured-status').dataset.status = numericalPass ? report.status : 'failed';
    $('measured-status').textContent = !numericalPass ? 'Numerical acceptance failed · diagnostic curves only' : report.status === 'inconclusive' ? 'Numerical checks passed · physical validation remains inconclusive' : `Measured comparison · ${report.status}`;
    if (numericalPass && ['openpwr-krsko-pressure-development-v1','openpwr-krsko-pressure-spray-development-v1'].includes(report.schema)) $('measured-status').textContent = `Numerical checks passed · ${report.pairedGuards?.caseImprovementPassed ? 'paired development criteria passed' : 'paired development criteria not met'} · physical validation remains inconclusive`;
    $('measured-scope').append(make('strong', report.conclusion || 'Read the comparison scope and assumptions.'), make('p', report.scope || 'A boundary-driven thermal-system comparison; no full-plant qualification is established.'));
    const identity = $('measured-identity');
    definition(identity, 'Source revision', report.gitRevision); definition(identity, 'Benchmark FMU', report.runtime.model);
    if (source) definition(identity, 'Complete report SHA-256', source.sha256);
    definition(identity, 'Benchmark FMU SHA-256', report.runtime.fmuSha256); definition(identity, 'Measured data SHA-256', report.inputDataSha256);
    if (report.coldSourceSha256) definition(identity, 'Shared startup thermal source SHA-256', report.coldSourceSha256);
    if (report.pressureSourceSha256) definition(identity, 'Pressure model source SHA-256', report.pressureSourceSha256);
    if (report.comparisonRole) definition(identity, 'Comparison role', report.comparisonRole);
    if (report.releasedBaseline) {
      definition(identity, 'Historical baseline', `v${report.releasedBaseline.version} · ${report.releasedBaseline.gitRevision}`);
      definition(identity, 'Baseline report SHA-256', report.releasedBaseline.reportSha256 ?? report.releasedBaseline.sha256);
    }
    if (report.source?.title) definition(identity, 'Measurement source', report.source.title);
    if (report.source?.url && /^https:\/\//.test(report.source.url)) { const link = make('a', 'Original published report ↗'); link.href = report.source.url; $('measurement-links').append(link); }
    for (const assumption of report.assumptions || []) $('measurement-assumptions').append(make('li', typeof assumption === 'string' ? assumption : describe(assumption)));
    for (const [key, value] of Object.entries(report.numericalEvidence || {})) definition($('measurement-numerics'), label(key), describe(value));
    for (const check of report.numericalChecks || []) definition($('measurement-numerics'), check.name, `${check.pass ? 'PASS' : 'FAIL'} · ${format(check.value)} (tolerance ${format(check.absoluteTolerance)})`);
    for (const check of report.pairedGuards?.checks || []) definition($('measurement-numerics'), check.name || `${check.reference} · ${check.channel} · ${check.metric}`, `${check.pass ? 'PASS' : 'FAIL'} · ${describe(check)}`);
    for (const channel of report.channels) { const option = make('option', `${channel.label || channel.name} · ${channel.unit}`); option.value = channel.name; $('measured-channel').append(option); }
    $('measured-channel').disabled = false; drawComparison();
  } catch (error) { if (request === evidenceRequest) { measured = null; $('measured-status').dataset.status = 'failed'; $('measured-status').textContent = error.message; $('measured-caption').textContent = 'No completed comparison available for this case.'; drawComparison(); } }
}
$('measured-channel').addEventListener('change', drawComparison);
$('measured-case').addEventListener('change', measuredEvidence);
const requestedCase = new URLSearchParams(location.search).get('case');
if (requestedCase && Object.hasOwn(casePaths, requestedCase)) $('measured-case').value = requestedCase;
void nativeEvidence(); void measuredEvidence();
