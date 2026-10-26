// SPDX-License-Identifier: Apache-2.0
const $ = id => document.getElementById(id);
const make = (tag, text, cls) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (cls) element.className = cls; return element; };
const fmt = value => typeof value === 'number' ? (value !== 0 && Math.abs(value) < .001 ? value.toExponential(4) : value.toLocaleString('en-US', { maximumSignificantDigits: 8 })) : String(value ?? '—');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
let native = null;
const traces = {};
async function report(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Report unavailable (HTTP ${response.status}). Generate it with npm run engineering:verify.`);
  const value = await response.json();
  if (!value || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 500
      || value.total !== value.checks.length || value.passed !== value.checks.filter(item => item.pass === true).length
      || value.checks.some(item => typeof item.name !== 'string' || typeof item.pass !== 'boolean')) throw new Error('Report schema or check totals are inconsistent.');
  return value;
}
function definition(list, name, value) { list.append(make('dt', name), make('dd', value)); }
function readable(key) { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()); }
function evidenceValue(value) {
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${readable(key)}: ${fmt(item)}`).join('; ');
  return fmt(value);
}
function card(check) {
  const article = make('article', undefined, 'native-check');
  article.append(make('span', check.pass ? 'PASS' : 'FAIL', `result ${check.pass ? 'pass' : 'fail'}`), make('h3', check.name));
  const list = make('dl');
  const evidence = check.evidence || Object.fromEntries(Object.entries(check).filter(([key]) => !['name', 'pass', 'source', 'category'].includes(key)));
  for (const [key, value] of Object.entries(evidence)) definition(list, readable(key), evidenceValue(value));
  article.append(list); return article;
}
function svg(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}
function drawTrace() {
  const key = $('trace-metric').value;
  const points = (traces[$('trace-case').value] || []).filter(point => Number.isFinite(point.time) && Number.isFinite(point.outputs?.[key]));
  const chart = $('native-trace'); chart.replaceChildren();
  if (!points.length) { chart.append(svg('text', { x: 450, y: 150, 'text-anchor': 'middle', fill: '#8fa7b5' }, 'No recorded observations available')); return; }
  const values = points.map(point => point.outputs[key]);
  let low = Math.min(...values), high = Math.max(...values);
  const spread = Math.max(high - low, Math.abs(high) * .00001, .00001);
  low -= spread * .12; high += spread * .12;
  const start = points[0].time, end = points.at(-1).time;
  const x = t => 90 + (t - start) / Math.max(.1, end - start) * 785;
  const y = value => 260 - (value - low) / (high - low) * 230;
  for (let i = 0; i < 5; i++) {
    const value = low + i * (high - low) / 4;
    chart.append(svg('path', { d: `M90 ${y(value)}H875`, stroke: '#28424d', fill: 'none' }), svg('text', { x: 80, y: y(value) + 4, fill: '#94acb9', 'text-anchor': 'end', 'font-size': 12 }, fmt(value)));
    const t = start + i * (end - start) / 4;
    chart.append(svg('text', { x: x(t), y: 285, fill: '#94acb9', 'text-anchor': 'middle', 'font-size': 12 }, `${fmt(t)} s`));
  }
  chart.append(svg('path', { d: points.map((point, i) => `${i ? 'L' : 'M'}${x(point.time)} ${y(point.outputs[key])}`).join(' '), fill: 'none', stroke: '#80d9c7', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
  $('trace-caption').textContent = `${points.length} stored observations · ${$('trace-metric').selectedOptions[0].textContent} · initial ${fmt(values[0])}, final ${fmt(values.at(-1))}. Generic subsystem response.`;
}
async function loadNative() {
  try {
    native = await report('./engineering-verification.json');
    if (native.runtime?.model !== 'OpenPWR.PrimaryLoop' || !hash(native.runtime.fmuSha256) || !hash(native.buildManifest?.sourceSha256)) throw new Error('Native model provenance is incomplete.');
    $('native-status').textContent = `${native.passed}/${native.total} subsystem checks passed · v${native.version}`;
    const identity = $('native-identity');
    definition(identity, 'Model', native.runtime.model); definition(identity, 'Compiler', native.runtime.compiler);
    definition(identity, 'Source revision', native.gitRevision || 'Source archive; no Git revision available');
    definition(identity, 'Source SHA-256', native.buildManifest.sourceSha256); definition(identity, 'FMU SHA-256', native.runtime.fmuSha256);
    definition(identity, 'Working tree', native.gitDirty ? 'Modified when checked' : 'Clean when checked');
    $('native-checks').replaceChildren(...native.checks.map(card));
    for (const [name, points] of Object.entries(native.traces || {})) if (Array.isArray(points) && points.length <= 10000) traces[name] = points;
    $('trace-case').replaceChildren(...Object.keys(traces).map(name => { const option = make('option', readable(name)); option.value = name; return option; }));
    $('trace-case').disabled = !Object.keys(traces).length;
    if (traces.heater) $('trace-case').value = 'heater';
    drawTrace();
  } catch (error) { native = null; $('native-status').textContent = error.message; drawTrace(); }
}
async function loadProperties() {
  try {
    const properties = await report('./modelica-property-verification.json');
    if (!hash(properties.fmuSha256) || !hash(properties.sourceSha256)) throw new Error('Property-probe provenance is incomplete.');
    if (native && native.buildManifest.sourceSha256 !== properties.sourceSha256) throw new Error('Property probe and subsystem reports use different model source. Rebuild both before comparing them.');
    const isPublished = check => check.category === 'published-water-property' || (!check.category && Boolean(check.source?.url));
    const published = properties.checks.filter(isPublished);
    const consistency = properties.checks.filter(check => !isPublished(check));
    $('property-status').textContent = `${published.filter(check => check.pass).length}/${published.length} published reference comparisons passed${consistency.length ? ` · ${consistency.filter(check => check.pass).length}/${consistency.length} numerical consistency checks passed` : ''}`;
    $('property-checks').replaceChildren(...published.map(check => {
      const row = make('tr'), title = make('td', check.name);
      const url = new URL(check.source.url);
      if (url.protocol === 'https:') { const link = make('a', check.source.title || 'Published source'); link.href = url.href; title.append(make('br'), link); }
      title.append(make('small', check.units || ''));
      row.append(title, make('td', fmt(check.reference)), make('td', fmt(check.measured)), make('td', `${fmt(check.absoluteError)} / ${fmt(check.tolerance)}`), make('td', check.pass ? 'PASS' : 'FAIL', `result ${check.pass ? 'pass' : 'fail'}`)); return row;
    }));
    $('consistency-details').hidden = !consistency.length;
    $('property-consistency').replaceChildren(...consistency.map(card));
  } catch (error) { $('property-status').textContent = error.message; }
}
$('trace-case').addEventListener('change', drawTrace); $('trace-metric').addEventListener('change', drawTrace);
await loadNative(); await loadProperties();
