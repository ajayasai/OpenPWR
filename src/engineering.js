// SPDX-License-Identifier: Apache-2.0
import { createPlantView } from './plant-view.js';
// The engineering workbench renders only observations returned by the native FMU.
// Display animation and charts never advance or calculate plant physics.
const $ = id => document.getElementById(id);
const plantView = createPlantView({ host: $('plant-3d'), schematic: $('plant-schematic'), mode: 'native' });
const inputs = [...document.querySelectorAll('[data-engineering-control]')];
const number = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const units = { reactorPowerMW: ' MW', pumpCommand: '%', steamTemperatureC: ' °C', heaterPowerMW: ' MW', sprayFlowKgS: ' kg/s', chargingFlowKgS: ' kg/s', letdownFlowKgS: ' kg/s' };
const digits = { reactorPowerMW: 0, pumpCommand: 0, steamTemperatureC: 1, heaterPowerMW: 2, sprayFlowKgS: 1, chargingFlowKgS: 2, letdownFlowKgS: 2 };
const expectedOutputs = ['hotLegTemperatureC', 'coldLegTemperatureC', 'fuelTemperatureC', 'primaryPressureMPa', 'pressurizerLevelPercent', 'primaryFlowKgS', 'pumpSpeed', 'heatToSteamMW', 'thermalEnergyMJ', 'pressurizerMassKg', 'pressurizerEnergyMJ', 'energyResidualMW', 'massResidualKgS'];
let connected = false, paused = true, busy = false, connecting = false;
let state = null, pendingControls = {}, resetQueued = false, exportQueued = false;
let pendingSessionAction = null, scenarios = [];
const planActive = () => ['ready', 'running'].includes(state?.experiment?.status);
let sessionHash = null;
let history = [], lastSampleTime = -Infinity, nextStepWall = 0, noticeTimer;
let lastFrame = performance.now(), flowPhase = 0, rotorPhase = 0, sprayPhase = 0;
let lastChartPaint = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const modelHalted = () => Boolean(state && (state.halted || !state.outputs.valid));
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

function clock(time) {
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.floor(time));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function text(id, value) { $(id).textContent = value; }
function notice(message, persistent = false) {
  clearTimeout(noticeTimer);
  text('engineering-notice', message);
  $('engineering-notice').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('engineering-notice').hidden = true; }, 6500);
}
function commandLabel(key, value) {
  return `${number(key === 'pumpCommand' ? value * 100 : value, digits[key])}${units[key]}`;
}
async function request(path, body, { download = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: download ? 'text/csv' : 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) {
      let message = `Engineering service returned HTTP ${response.status}.`;
      try { const detail = await response.json(); if (typeof detail.message === 'string') message = detail.message; } catch { /* Static hosts return HTML error pages. */ }
      const failure = new Error(message); failure.status = response.status; throw failure;
    }
    if (download) return await response.blob();
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('This address is serving the static site, not the native engineering service.');
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The engineering service did not respond within 20 seconds. Reconnect to read its current state before continuing.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function setConnection(available, message) {
  connected = available;
  if (!available) { paused = true; restoreConfirmedControls(); }
  $('connection-panel').classList.toggle('unavailable', !available);
  $('connection-dot').classList.toggle('connected', available);
  text('connection-title', available ? 'Connected to local OpenModelica model' : 'Native engineering service unavailable');
  text('connection-message', !available && state ? `${message} Last confirmed readings are retained; no further simulation steps are requested.` : message);
  if (!available) text('backend-performance', state ? 'Connection lost · readings retained' : 'Solver unavailable');
  $('local-instructions').hidden = available;
  updateAvailability();
}
function restoreConfirmedControls() {
  if (!state) return;
  for (const input of inputs) {
    input.value = state.controls[input.id];
    text(`${input.id}-output`, commandLabel(input.id, state.controls[input.id]));
  }
}
function updateAvailability() {
  const inactive = !connected || connecting || resetQueued || Boolean(pendingSessionAction);
  const halted = modelHalted();
  for (const input of inputs) input.disabled = inactive || halted || planActive();
  for (const button of document.querySelectorAll('[data-experiment]')) button.disabled = inactive || halted || planActive();
  $('engineering-run').disabled = inactive || halted || state?.experiment?.status === 'complete';
  $('engineering-reset').disabled = inactive;
  $('engineering-export').disabled = inactive || !state;
  $('engineering-reconnect').disabled = busy || connecting;
  $('engineering-speed').disabled = inactive || halted;
  $('scenario-select').disabled = inactive || !scenarios.length;
  $('scenario-prepare').disabled = inactive || !scenarios.length;
  $('scenario-stop').disabled = inactive || !['ready', 'running', 'complete'].includes(state?.experiment?.status);
  $('commands-export').disabled = inactive || !state;
  $('commands-import').disabled = inactive;
  text('engineering-run', paused ? 'Run model' : 'Pause');
  $('engineering-run').setAttribute('aria-pressed', String(!paused));
  const status = !connected ? state ? 'Connection lost' : 'Awaiting model' : halted ? 'Domain boundary' : paused ? 'Model paused' : 'Model running';
  text('engine-status', status);
  $('engine-status').classList.toggle('halted', halted);
}
function acceptState(next, { reset = false } = {}) {
  if (!next || next.backend !== 'fmi2' || next.model !== 'OpenPWR.PrimaryLoop'
      || !Number.isFinite(next.time) || next.time < 0 || typeof next.halted !== 'boolean'
      || !next.controls || !next.outputs || typeof next.outputs.valid !== 'boolean'
      || expectedOutputs.some(key => !Number.isFinite(next.outputs[key]))
      || inputs.some(input => !Number.isFinite(next.controls[input.id])
        || next.controls[input.id] < Number(input.min) || next.controls[input.id] > Number(input.max))) {
    throw new Error('The service returned an incomplete or nonfinite engineering state. The display is paused.');
  }
  if (reset || (state && next.time < state.time)) { history = []; lastSampleTime = -Infinity; }
  state = next;
  if (next.experiment?.status === 'complete') paused = true;
  if (next.halted || !next.outputs.valid) paused = true;
  if (!history.length || next.time - lastSampleTime >= 1 - 1e-8 || next.halted) {
    if (history.at(-1)?.time === next.time) history[history.length - 1] = { time: next.time, ...next.outputs };
    else history.push({ time: next.time, ...next.outputs });
    lastSampleTime = next.time;
    if (history.length > 2400) history.splice(0, history.length - 2400);
  }
  render();
}
function render() {
  if (!state) { updateAvailability(); return; }
  const out = state.outputs, controls = state.controls;
  const values = {
    'engineering-time': clock(state.time), 'pressure-value': number(out.primaryPressureMPa, 3),
    'level-value': number(out.pressurizerLevelPercent, 1), 'hot-value': number(out.hotLegTemperatureC, 1),
    'flow-value': number(out.primaryFlowKgS, 0), 'cold-note': `Cold leg ${number(out.coldLegTemperatureC, 1)} °C`,
    'pump-note': `Pump speed ${number(out.pumpSpeed * 100, 1)}%`,
    'diagram-pressure': `${number(out.primaryPressureMPa, 3)} MPa`, 'diagram-level': `${number(out.pressurizerLevelPercent, 1)}% liquid`,
    'diagram-heater': `Heater ${number(controls.heaterPowerMW, 2)} MW`, 'diagram-spray': `Spray ${number(controls.sprayFlowKgS, 1)} kg/s`,
    'diagram-power': `Input ${number(controls.reactorPowerMW, 0)} MW`, 'diagram-fuel': `Fuel ${number(out.fuelTemperatureC, 1)} °C`,
    'diagram-hot': `${number(out.hotLegTemperatureC, 1)} °C`, 'diagram-cold': `${number(out.coldLegTemperatureC, 1)} °C`,
    'diagram-pump': `Pump ${number(out.pumpSpeed * 100, 1)}%`, 'diagram-transfer': `${number(out.heatToSteamMW, 1)} MW to boundary`,
    'diagram-boundary': `${number(controls.steamTemperatureC, 1)} °C`,
    'energy-residual': `${number(out.energyResidualMW, 6)} MW`, 'mass-residual': `${number(out.massResidualKgS, 6)} kg/s`,
    'thermal-energy': `${number(out.thermalEnergyMJ, 0)} MJ`, 'pressurizer-mass': `${number(out.pressurizerMassKg, 0)} kg`,
    'pressurizer-energy': `${number(out.pressurizerEnergyMJ, 0)} MJ`,
    'sample-count': `${history.length.toLocaleString('en-US')} solver observations retained · last 10 minutes shown · time mm:ss`,
  };
  for (const [id, value] of Object.entries(values)) text(id, value);
  for (const input of inputs) {
    const key = input.dataset.engineeringControl;
    if (!(key in pendingControls) && document.activeElement !== input) {
      input.value = controls[key];
      text(`${key}-output`, commandLabel(key, controls[key]));
    }
  }
  const level = clamp(out.pressurizerLevelPercent, 0, 100) / 100;
  $('pressurizer-liquid').setAttribute('height', String(94 * level));
  $('pressurizer-liquid').setAttribute('y', String(139 - 94 * level));
  $('heater-coil').style.opacity = String(.25 + .75 * clamp(controls.heaterPowerMW / 3, 0, 1));
  $('engineering-core-heat').style.opacity = String(.08 + .92 * clamp(controls.reactorPowerMW / 3000, 0, 1));
  $('engineering-halt').hidden = !state.halted && out.valid;
  if (state.halted || !out.valid) text('engineering-halt', `Model domain reached. ${state.haltReason || 'The solver state is outside this model’s supported range.'} Reset the hot initial condition to begin another experiment.`);
  const plan = state.experiment;
  const activePlan = plan && !['stopped', 'manual'].includes(plan.status);
  $('experiment-progress-bar').hidden = !activePlan;
  if (activePlan) {
    const fraction = plan.duration > 0 ? clamp(state.time / plan.duration, 0, 1) : 0;
    $('experiment-progress-bar').value = fraction;
    const comparison = plan.comparison ? (plan.comparison.pass ? ' · Replay matches saved endpoint' : ' · Replay endpoint differs — inspect report') : '';
    text('experiment-progress', `${plan.label} · ${plan.status} · ${clock(state.time)} / ${clock(plan.duration)} · ${plan.appliedEvents}/${plan.eventCount} events${comparison}`);
  } else text('experiment-progress', 'Manual experiment · controls are available');
  updateAvailability();
}
async function connect() {
  if (busy || connecting) return;
  connecting = true; busy = true; paused = true; pendingControls = {}; resetQueued = false; exportQueued = false; pendingSessionAction = null;
  updateAvailability();
  text('connection-title', 'Connecting to the engineering service');
  let health = null;
  try {
    health = await request('/api/health');
    if (health.available !== true || health.backend !== 'fmi2' || health.fmiVersion !== '2.0'
        || health.model !== 'OpenPWR.PrimaryLoop' || !validHash(health.fmuSha256)
        || ![.025, .05].includes(health.stepSize)) throw new Error('The service did not provide a complete FMI 2.0 primary-loop model identity.');
    const current = await request('/api/state');
    acceptState(current, { reset: Boolean(sessionHash && sessionHash !== health.fmuSha256) });
    sessionHash = health.fmuSha256;
    await restoreSessionHistory(health);
    await loadScenarios();
    restoreConfirmedControls();
    clearTimeout(noticeTimer);
    $('engineering-notice').hidden = true;
    setConnection(true, 'Controls and measurements are connected to the native model. Start the model to advance simulation time.');
    text('provenance-model', health.model || current.model);
    text('provenance-compiler', typeof health.compiler === 'string' ? health.compiler : health.compiler ? JSON.stringify(health.compiler) : 'Not recorded in the FMU manifest');
    text('provenance-hash', health.fmuSha256 || 'Not supplied');
    text('communication-step', `Native FMI co-simulation · ${number(health.stepSize * 1000, 0)} ms communication steps`);
    text('backend-performance', modelHalted() ? 'Native state loaded · halted' : 'Native state loaded · paused');
    nextStepWall = performance.now();
    charts();
  } catch (error) {
    setConnection(false, error.message);
  } finally {
    await readNativeEvidence(health);
    connecting = false; busy = false; updateAvailability();
  }
}
async function restoreSessionHistory(health) {
  try {
    const saved = await request('/api/history?maxPoints=600');
    if (saved.schema !== 'openpwr-fmi-history-v1' || saved.fmuSha256 !== health.fmuSha256
        || !Array.isArray(saved.points) || saved.points.length > 2400) return;
    let previous = -Infinity;
    const valid = saved.points.every(point => {
      const okay = Number.isFinite(point.time) && point.time >= 0 && point.time > previous
        && point.outputs && expectedOutputs.every(key => Number.isFinite(point.outputs[key]));
      previous = point.time; return okay;
    });
    if (!valid) return;
    if (saved.current) acceptState(saved.current);
    if (saved.points.some(point => point.time > state.time)) return;
    history = saved.points.map(point => ({ time: point.time, ...point.outputs }));
    lastSampleTime = history.at(-1)?.time ?? -Infinity;
    render();
  } catch { /* A compatible older service can still supply current observations. */ }
}
async function loadScenarios() {
  try {
    const catalogue = await request('/api/scenarios');
    if (catalogue.schema !== 'openpwr-fmi-scenarios-v1' || !Array.isArray(catalogue.scenarios)
        || catalogue.scenarios.length > 20 || catalogue.scenarios.some(item => typeof item.id !== 'string'
          || typeof item.label !== 'string' || typeof item.description !== 'string' || !Number.isFinite(item.duration))) return;
    const selected = $('scenario-select').value;
    scenarios = catalogue.scenarios;
    $('scenario-select').replaceChildren(...scenarios.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.label} · ${number(item.duration, 0)} s`; return option;
    }));
    if (scenarios.some(item => item.id === selected)) $('scenario-select').value = selected;
    describeScenario();
  } catch { scenarios = []; text('scenario-description', 'This service does not expose timed experiments. Restart with the current backend to enable them.'); }
}
function describeScenario() {
  const selected = scenarios.find(item => item.id === $('scenario-select').value);
  text('scenario-description', selected?.description || 'Choose an experiment.');
}
function queueSessionAction(route, body, message, reset = true) {
  if (!connected || connecting || pendingSessionAction) return;
  paused = true; pendingControls = {}; resetQueued = false;
  pendingSessionAction = { route, body, message, reset };
  updateAvailability();
}
async function readNativeEvidence(health) {
  $('native-evidence-link').hidden = true;
  try {
    const report = await request('./engineering-verification.json');
    if (report.schemaVersion !== 1 || !Array.isArray(report.checks) || !report.checks.length
        || report.checks.some(check => !check || typeof check.name !== 'string' || typeof check.pass !== 'boolean')
        || report.runtime?.backend !== 'fmi2' || report.runtime?.model !== 'OpenPWR.PrimaryLoop'
        || report.runtime?.fmiVersion !== '2.0' || !validHash(report.runtime?.fmuSha256)) throw new Error('Incomplete native report');
    const passed = report.checks.filter(check => check.pass === true).length;
    if (report.total !== report.checks.length || report.passed !== passed) throw new Error('Inconsistent native report totals');
    $('native-evidence-link').hidden = false;
    const matches = health?.fmuSha256 && health.fmuSha256 === report.runtime.fmuSha256;
    const message = health?.fmuSha256 && !matches
      ? 'A native report is available for a different FMU. It does not verify this session.'
      : `${passed}/${report.checks.length} native subsystem checks passed ${matches ? 'for this FMU' : 'in the published report'}. These checks do not establish measured plant validation.`;
    text('native-evidence-status', message);
  } catch {
    text('native-evidence-status', 'No complete native verification report is available here. Run npm run engineering:verify to generate it.');
  }
}
function queueControls(changes, message) {
  if (!connected || modelHalted() || planActive()) return;
  Object.assign(pendingControls, changes);
  for (const [key, value] of Object.entries(changes)) {
    $(key).value = value;
    text(`${key}-output`, commandLabel(key, value));
  }
  if (message) notice(message);
}
async function tick() {
  if (busy || connecting || !connected) return;
  let action = null;
  if (resetQueued) action = 'reset';
  else if (pendingSessionAction) action = 'session';
  else if (Object.keys(pendingControls).length) action = 'control';
  else if (exportQueued) action = 'export';
  else if (!paused && !document.hidden && !modelHalted() && performance.now() >= nextStepWall) action = 'step';
  if (!action) return;
  busy = true;
  updateAvailability();
  const start = performance.now();
  try {
    if (action === 'reset') {
      acceptState(await request('/api/reset', {}), { reset: true });
      resetQueued = false;
      text('backend-performance', 'Model reset');
      notice('Native model reset to its documented hot initial condition.');
      charts();
    } else if (action === 'session') {
      const operation = pendingSessionAction;
      pendingSessionAction = null;
      acceptState(await request(operation.route, operation.body), { reset: operation.reset });
      paused = true;
      restoreConfirmedControls();
      notice(operation.message);
      charts();
    } else if (action === 'control') {
      const changes = pendingControls;
      pendingControls = {};
      acceptState(await request('/api/control', changes));
    } else if (action === 'export') {
      const kind = exportQueued;
      exportQueued = false;
      const file = kind === 'commands' ? new Blob([JSON.stringify(await request('/api/commands'), null, 2)], { type: 'application/json' }) : await request('/api/export', undefined, { download: true });
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = `openpwr-engineering-${Math.floor(state.time)}s.${kind === 'commands' ? 'json' : 'csv'}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const simulatedSeconds = .25 * Number($('engineering-speed').value);
      nextStepWall = start + 250;
      acceptState(await request('/api/step', { seconds: simulatedSeconds }));
      const elapsed = performance.now() - start;
      text('backend-performance', `${number(elapsed, 0)} ms solver request / ${number(simulatedSeconds, 2)} s simulated`);
    }
  } catch (error) {
    // A timed-out request may have advanced the native model. Require an explicit
    // state refresh before issuing another command instead of replaying blindly.
    pendingControls = {}; resetQueued = false; exportQueued = false; pendingSessionAction = null;
    paused = true;
    if (action === 'session' && error.status >= 400 && error.status < 500) {
      try {
        // A time-zero native control can fail after initialization. Recover the
        // authoritative state even though validation normally precedes reset.
        acceptState(await request('/api/state'));
        restoreConfirmedControls();
        notice(`Experiment could not be loaded. ${error.message} Current solver state refreshed and paused.`, true);
      } catch (recoveryError) {
        setConnection(false, recoveryError.message);
        notice(`Experiment request failed; reconnect to recover its current state. ${error.message}`, true);
      }
    } else {
      setConnection(false, error.message);
      notice(`Engineering session paused. ${error.message}`, true);
    }
  } finally { busy = false; updateAvailability(); }
}

const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes, content) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = content;
  return node;
}
function drawChart(id, series, defaults) {
  const el = $(id), width = Math.max(180, el.clientWidth), height = el.clientHeight || 180;
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.replaceChildren();
  if (!history.length) { el.append(svg('text', { x: width / 2, y: height / 2, fill: '#708c9e', 'text-anchor': 'middle', 'font-size': 11 }, 'Awaiting solver observations')); return; }
  const end = history.at(-1).time, begin = Math.max(0, end - 600);
  const points = history.filter(point => point.time >= begin);
  const values = points.flatMap(point => series.map(item => point[item.key]));
  let min = Math.min(...values), max = Math.max(...values);
  if (max - min < defaults[1]) { const middle = (max + min) / 2; min = middle - defaults[1] / 2; max = middle + defaults[1] / 2; }
  const margin = (max - min) * .12; min -= margin; max += margin;
  const left = 42, right = 8, top = 12, bottom = 25, plotW = width - left - right, plotH = height - top - bottom;
  const x = t => left + (t - begin) / Math.max(end - begin, 10) * plotW;
  const y = value => top + (max - value) / (max - min) * plotH;
  for (let i = 0; i < 4; i++) {
    const value = min + (max - min) * i / 3, py = y(value);
    el.append(svg('path', { d: `M${left} ${py} H${width - right}`, stroke: '#263b48', 'stroke-width': .7 }));
    el.append(svg('text', { x: left - 7, y: py + 3, fill: '#7895a6', 'text-anchor': 'end', 'font-size': 9 }, number(value, defaults[0])));
  }
  for (let i = 0; i < 3; i++) {
    const t = begin + Math.max(end - begin, 10) * i / 2;
    el.append(svg('text', { x: left + i * plotW / 2, y: height - 4, fill: '#7895a6', 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle', 'font-size': 9 }, `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`));
  }
  for (const item of series) {
    el.append(svg('path', { d: points.map((point, i) => `${i ? 'L' : 'M'}${x(point.time).toFixed(2)} ${y(point[item.key]).toFixed(2)}`).join(' '), fill: 'none', stroke: item.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
    const last = points.at(-1);
    el.append(svg('circle', { cx: x(last.time), cy: y(last[item.key]), r: 2.3, fill: item.color }));
  }
}
function charts() {
  drawChart('pressure-chart', [{ key: 'primaryPressureMPa', color: '#8bded1' }], [2, .04]);
  drawChart('temperature-chart', [{ key: 'hotLegTemperatureC', color: '#eabc79' }, { key: 'coldLegTemperatureC', color: '#72d2ca' }], [0, 1]);
}
const flowPaths = [...document.querySelectorAll('.flow')], droplets = [...$('spray-droplets').children];
function animate(now) {
  plantView.update(state, { paused: paused || !connected || modelHalted(), hidden: document.hidden });
  const dt = Math.min(.1, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
  const active = connected && !paused && !modelHalted() && !document.hidden && !reducedMotion.matches;
  if (state) {
    const out = state.outputs, spray = state.controls.sprayFlowKgS;
    if (active) {
      flowPhase = (flowPhase + dt * clamp(out.primaryFlowKgS / 15584.4156, -2, 2) * 48 + 28) % 28;
      rotorPhase = (rotorPhase + dt * clamp(out.pumpSpeed, 0, 2) * 110) % 360;
      sprayPhase = (sprayPhase + dt * Math.sqrt(Math.max(0, spray) / 5) * 18) % 32;
    }
    for (const path of flowPaths) { path.style.strokeDashoffset = String(-flowPhase); path.style.opacity = Math.abs(out.primaryFlowKgS) < .01 ? '0' : '1'; }
    $('engineering-pump-rotor').setAttribute('transform', `rotate(${rotorPhase} 360 350)`);
    $('spray-droplets').style.opacity = spray > .001 ? '.9' : '0';
    for (let i = 0; i < droplets.length; i++) droplets[i].setAttribute('cy', String(63 + (sprayPhase + i * 11) % 32));
  }
  const label = reducedMotion.matches ? 'Reduced motion' : !connected ? 'Awaiting model' : paused || modelHalted() ? 'Motion paused' : 'Live model motion';
  if ($('motion-status').textContent !== label) text('motion-status', label);
  if (now - lastChartPaint > 500) { charts(); lastChartPaint = now; }
  requestAnimationFrame(animate);
}

for (const input of inputs) {
  input.addEventListener('input', () => text(`${input.id}-output`, commandLabel(input.id, Number(input.value))));
  input.addEventListener('change', () => queueControls({ [input.id]: Number(input.value) }));
  input.addEventListener('blur', () => { if (state && !(input.id in pendingControls)) text(`${input.id}-output`, commandLabel(input.id, state.controls[input.id])); });
}
$('engineering-run').addEventListener('click', () => { if (!connected || modelHalted()) return; paused = !paused; nextStepWall = performance.now(); updateAvailability(); });
$('engineering-reconnect').addEventListener('click', connect);
$('engineering-reset').addEventListener('click', () => { if (!connected) return; paused = true; pendingControls = {}; resetQueued = true; updateAvailability(); });
$('engineering-export').addEventListener('click', () => { exportQueued = true; });
$('commands-export').addEventListener('click', () => { exportQueued = 'commands'; });
$('commands-import').addEventListener('click', () => $('commands-file').click());
$('commands-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('Command history exceeds the 4 MiB limit.');
    const commands = JSON.parse(await file.text());
    queueSessionAction('/api/replay', commands, 'Command history validated and prepared. Press Run model to replay.');
  } catch (error) { notice(`Could not read command history. ${error.message}`, true); }
});
$('scenario-select').addEventListener('change', describeScenario);
$('scenario-prepare').addEventListener('click', () => {
  queueSessionAction('/api/experiment', { scenario: $('scenario-select').value }, 'Experiment prepared at its hot initial condition. Press Run model.');
});
$('scenario-stop').addEventListener('click', () => {
  queueSessionAction('/api/experiment/stop', {}, 'Timed sequence stopped. Current model state retained; manual controls are available.', false);
});
const experiments = { power: [{ reactorPowerMW: 2700 }, 'Applying a 10% reactor heat-input reduction.'], pump: [{ pumpCommand: .8 }, 'Applying an 80% primary-pump command.'], spray: [{ sprayFlowKgS: 5 }, 'Applying 5 kg/s pressurizer spray.'], heater: [{ heaterPowerMW: 1 }, 'Applying 1 MW pressurizer heater power.'] };
for (const button of document.querySelectorAll('[data-experiment]')) button.addEventListener('click', () => {
  const [changes, message] = experiments[button.dataset.experiment];
  queueControls(changes, message); paused = false; nextStepWall = performance.now(); updateAvailability();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { paused = true; updateAvailability(); } lastFrame = performance.now(); });
new ResizeObserver(charts).observe($('engineering-trends-title').closest('.panel'));
setInterval(() => { void tick(); }, 60);
charts();
requestAnimationFrame(animate);
void connect();
