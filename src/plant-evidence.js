// SPDX-License-Identifier: Apache-2.0
const $ = id => document.getElementById(id);
const make = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const format = value => typeof value === 'number' ? Number.isFinite(value) ? (value !== 0 && Math.abs(value) < .001 ? value.toExponential(3) : value.toLocaleString('en-US', { maximumSignificantDigits: 6 })) : '—' : String(value ?? '—');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase());
const describe = value => Array.isArray(value) ? value.map(describe).join('; ') : value && typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${label(key)}: ${describe(item)}`).join('; ') : format(value);
function definition(target, name, value) { target.append(make('dt', name), make('dd', format(value))); }
async function read(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Evidence unavailable (HTTP ${response.status}). Generate the current native reports before publishing.`);
  return response.json();
}
async function nativeEvidence() {
  try {
    const report = await read('./plant-verification.json');
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
const casePaths = { krsko: './measured-validation.json', pactel: './pressurizer-validation.json', 'pactel-holdout': './pressurizer-validation.json' };
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes, text) {
  const el = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text; return el;
}
function drawComparison() {
  const chart = $('measured-chart'); chart.replaceChildren(); $('measurement-metrics').replaceChildren();
  const channel = measured?.channels.find(item => item.name === $('measured-channel').value);
  const points = channel?.points?.filter(item => Number.isFinite(item.time)) || [];
  if (!points.length) { chart.append(svg('text', { x: 450, y: 165, fill: '#91acb8', 'text-anchor': 'middle' }, 'No measured comparison available')); return; }
  const values = points.flatMap(point => [point.measured, point.simulated, point.baseline, point.lowerAllowance, point.upperAllowance]).filter(Number.isFinite);
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
  const bounded = points.filter(point => Number.isFinite(point.lowerAllowance) && Number.isFinite(point.upperAllowance));
  if (bounded.length) {
    const polygon = [...bounded.map(point => `${x(point.time)},${y(point.upperAllowance)}`), ...bounded.slice().reverse().map(point => `${x(point.time)},${y(point.lowerAllowance)}`)].join(' ');
    chart.append(svg('polygon', { points: polygon, fill: '#ecb3db', opacity: .10 }));
  }
  for (const [key, color] of [['baseline', '#81929d'], ['measured', '#ecb3db'], ['simulated', '#86dfd0']]) {
    let path = '', previous = false;
    for (const point of points) {
      if (!Number.isFinite(point[key])) { previous = false; continue; }
      path += `${previous ? ' L' : ' M'}${x(point.time)} ${y(point[key])}`; previous = true;
      if (key === 'measured' && (points.length < 100 || points.indexOf(point) % 10 === 0)) chart.append(svg('circle', { cx: x(point.time), cy: y(point[key]), r: 2.8, fill: color }));
    }
    chart.append(svg('path', { d: path, stroke: color, fill: 'none', 'stroke-width': 2, 'stroke-dasharray': key === 'baseline' ? '6 5' : 'none', 'stroke-linejoin': 'round' }));
  }
  $('measured-caption').textContent = `${channel.label || channel.name} · ${channel.unit} · ${channel.metrics?.samples ?? points.filter(point => Number.isFinite(point.measured)).length} comparison points. ${channel.description || 'Published measurements compared with the boundary-driven native model.'}${bounded.length ? ' Shading combines the documented reading, timing and instrument allowances; it is not a statistical confidence interval.' : ''}`;
  for (const [key, value] of Object.entries(channel.metrics || {})) {
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
  drawComparison();
  try {
    const parent = await read(path);
    const report = $('measured-case').value === 'pactel-holdout' ? parent.holdoutComparison : parent;
    if (request !== evidenceRequest) return;
    if (!report) throw new Error('The reserved-event comparison is not available in this build.');
    if (report.executed !== true) throw new Error(`Comparison did not complete. ${report.error || 'Read the saved report for diagnostics.'}`);
    if (report.schema !== 'openpwr-measured-validation-v1' || !Array.isArray(report.channels) || !report.channels.length || report.channels.length > 30
        || !hash(report.runtime?.fmuSha256) || !hash(report.inputDataSha256)
        || report.channels.some(channel => typeof channel.name !== 'string' || !Array.isArray(channel.points) || channel.points.length > 10000)) throw new Error('Measured report provenance or channel schema is incomplete.');
    measured = report;
    const numericalPass = report.numericalPassed === true && Array.isArray(report.numericalChecks) && report.numericalChecks.length > 0 && report.numericalChecks.every(check => check.pass === true && Number.isFinite(check.value) && Number.isFinite(check.absoluteTolerance) && check.absoluteTolerance >= 0 && Math.abs(check.value) <= check.absoluteTolerance);
    $('measured-status').dataset.status = numericalPass ? report.status : 'failed';
    $('measured-status').textContent = !numericalPass ? 'Numerical acceptance failed · diagnostic curves only' : report.status === 'inconclusive' ? 'Numerical checks passed · physical validation remains inconclusive' : `Measured comparison · ${report.status}`;
    $('measured-scope').append(make('strong', report.conclusion || 'Read the comparison scope and assumptions.'), make('p', report.scope || 'A boundary-driven thermal-system comparison; no full-plant qualification is established.'));
    const identity = $('measured-identity');
    definition(identity, 'Source revision', report.gitRevision); definition(identity, 'Benchmark FMU', report.runtime.model);
    definition(identity, 'Benchmark FMU SHA-256', report.runtime.fmuSha256); definition(identity, 'Measured data SHA-256', report.inputDataSha256);
    if (report.source?.title) definition(identity, 'Measurement source', report.source.title);
    if (report.source?.url && /^https:\/\//.test(report.source.url)) { const link = make('a', 'Original published report ↗'); link.href = report.source.url; $('measurement-links').append(link); }
    for (const assumption of report.assumptions || []) $('measurement-assumptions').append(make('li', typeof assumption === 'string' ? assumption : describe(assumption)));
    for (const [key, value] of Object.entries(report.numericalEvidence || {})) definition($('measurement-numerics'), label(key), describe(value));
    for (const check of report.numericalChecks || []) definition($('measurement-numerics'), check.name, `${check.pass ? 'PASS' : 'FAIL'} · ${format(check.value)} (tolerance ${format(check.absoluteTolerance)})`);
    for (const channel of report.channels) { const option = make('option', `${channel.label || channel.name} · ${channel.unit}`); option.value = channel.name; $('measured-channel').append(option); }
    $('measured-channel').disabled = false; drawComparison();
  } catch (error) { if (request === evidenceRequest) { measured = null; $('measured-status').dataset.status = 'failed'; $('measured-status').textContent = error.message; $('measured-caption').textContent = 'No completed comparison available for this case.'; drawComparison(); } }
}
$('measured-channel').addEventListener('change', drawComparison);
$('measured-case').addEventListener('change', measuredEvidence);
void nativeEvidence(); void measuredEvidence();
