// SPDX-License-Identifier: Apache-2.0
import { PWRPlant } from './engine.js';
import { createDiagramAnimation } from './diagram.js';

// All readings originate in the same engine used by the command-line test suite.
// No network requests, telemetry, external chart library, or UI-derived physics.
const plant = new PWRPlant();
const $ = (id) => document.getElementById(id);
const diagram = createDiagramAnimation();
const DT = 0.05;
const MAX_HISTORY = 86400; // 24 h at 1 Hz; pruned in chunks to keep accelerated runs responsive.
const FRAME_WORK_BUDGET_MS = 12;
const SPEEDS = [1, 5, 20, 100, 300, 1000];
const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = { cyan: '#60d4ce', amber: '#edb465', blue: '#679de1' };
const FAULTS = ['primaryPumpTrip', 'feedwaterTrip', 'turbineTrip', 'lossOfHeatSink'];
const faultDescriptions = {
  primaryPumpTrip: 'Primary pump trip applied. Observe coolant coastdown, heat transfer, and reactor protection.',
  feedwaterTrip: 'Feedwater loss applied. Observe steam-generator inventory and the secondary heat sink.',
  turbineTrip: 'Turbine trip applied. Observe steam pressure, electrical output, and reactor protection.',
  lossOfHeatSink: 'Cooling-water loss applied. Observe condenser pressure and the turbine response.',
};
let paused = false;
let speed = 1;
let accumulator = 0;
let sampleAccumulator = 0;
let lastFrame = performance.now();
let lastPaint = 0;
let lastChartPaint = 0;
let lastSnapshot = plant.snapshot();
let history = [sample(lastSnapshot)];
let historyOffset = 0;
let alarmSignature = '';
let eventSignature = '';
let noticeTimer;
let lastRateWall = performance.now();
let lastRateSim = lastSnapshot.time;
let startupSignature = '';
const STARTUP_STAGES = ['cold', 'prepared', 'heatup', 'hotStandby', 'turbineRoll', 'power'];
const STAGE_LABELS = { cold: 'Cold shutdown', prepared: 'Establishing circulation', heatup: 'Reactor heat-up', hotStandby: 'Hot thermal hold', turbineRoll: 'Turbine roll', power: 'Power mode' };

function fmt(value, digits = 0) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
}
function smallNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value !== 0 && Math.abs(value) < .01 ? value.toExponential(digits) : fmt(value, digits);
}
function clock(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function setText(id, value) { $(id).textContent = value; }
function setBar(id, value) { $(id).style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`; }
function notify(message, persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
}
function sample(s) {
  const keys = ['time', 'neutronPower', 'thermalPower', 'electricPower', 'grossPower', 'decayPower', 'fuelTemp', 'hotLegTemp', 'coldLegTemp', 'primaryPressure', 'steamPressure', 'steamTemp', 'steamLevel', 'steamFlow', 'feedFlow', 'primaryFlow', 'condenserPressure', 'condenserTemp', 'turbineSpeed', 'reactivity', 'rodReactivity', 'xenon', 'iodine', 'pumpSpeed', 'turbineValve', 'energyResidual', 'efficiency', 'heatupTarget', 'heatupRateCPerHour', 'rotorEnergyMJ', 'auxiliaryHeatMW', 'sourceStrength'];
  const out = {};
  for (const key of keys) out[key] = s[key];
  out.tripped = s.tripped;
  out.gridConnected = s.gridConnected;
  out.startupStage = s.startupStage;
  return out;
}
function record(s) {
  history.push(sample(s));
  if (history.length - historyOffset > MAX_HISTORY) historyOffset++;
  if (historyOffset >= 4096) { history = history.slice(historyOffset); historyOffset = 0; }
}
function resetHistory(s) {
  history = [sample(s)]; historyOffset = 0; sampleAccumulator = 0;
  lastRateWall = performance.now(); lastRateSim = s.time;
}
function setPaused(value) {
  paused = value;
  accumulator = 0;
  lastFrame = performance.now();
  $('play-pause').setAttribute('aria-pressed', String(paused));
  setText('play-label', paused ? 'Run' : 'Pause');
  setText('play-icon', paused ? '▶' : 'Ⅱ');
  $('live-dot').classList.toggle('paused', paused);
  document.body.classList.toggle('paused', paused);
  diagram.update(lastSnapshot, { paused, hidden: document.hidden });
}
function mutate(action, message) {
  try {
    action();
    lastSnapshot = plant.snapshot();
    syncControls(lastSnapshot);
    render(lastSnapshot);
    renderCharts();
    if (message) notify(message);
  } catch (error) {
    notify(`Action could not be applied: ${error.message}`, true);
  }
}
function syncControls(s) {
  for (const input of document.querySelectorAll('[data-control]')) {
    const key = input.dataset.control;
    if (!(key in s.controls)) continue;
    if (input.type === 'checkbox') input.checked = s.controls[key];
    else input.value = key === 'rodReactivity' ? s.controls[key] : s.controls[key] * 100;
  }
  $('rod-reactivity').disabled = Boolean(s.controls.autoReactor);
  $('feedwater').disabled = Boolean(s.controls.autoFeedwater);
  $('turbine-valve').disabled = Boolean(s.controls.autoTurbine);
  $('demand').disabled = Boolean(s.startupMode && s.startupStage !== 'power');
  const outputs = [
    ['demand-output', s.controls.demand * 100, ''],
    ['primary-pump-output', s.controls.primaryPump * 100, '%'],
    ['cooling-output', s.controls.cooling * 100, '%'],
    ['rod-reactivity-output', s.controls.rodReactivity, ' pcm'],
    ['feedwater-output', s.controls.feedwater * 100, '%'],
    ['turbine-valve-output', s.controls.turbineValve * 100, '%'],
    ['startup-power-output', s.controls.startupPower * 100, '% thermal'],
  ];
  for (const [id, value, unit] of outputs) setText(id, `${fmt(value, ['demand-output', 'startup-power-output'].includes(id) && !Number.isInteger(value) ? 1 : 0)}${unit}`);
  setText('demand-mw', s.startupMode && s.startupStage !== 'power' ? 'Engages after grid connection' : `${fmt(s.controls.demand * 1000)} MWe target`);
  for (const button of document.querySelectorAll('[data-fault]')) {
    const on = Boolean(s.faults[button.dataset.fault]);
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
}

function render(s) {
  if (s.domainExceeded) {
    setPaused(true);
    $('domain-notice').hidden = false;
    const message = `Model validity boundary reached — simulation paused. ${s.domainReason || 'The state is outside the supported model range.'} Initialize a new experiment to continue.`;
    if ($('domain-notice').textContent !== message) $('domain-notice').textContent = message;
  } else $('domain-notice').hidden = true;
  setText('sim-time', clock(s.time));
  setText('net-power', fmt(s.electricPower));
  setText('thermal-power', fmt(s.thermalPower));
  setText('primary-pressure', fmt(s.primaryPressure, 2));
  setText('efficiency', fmt(s.efficiency, 1));
  setText('net-percent', s.electricPower < 0 ? `Auxiliary import ${fmt(Math.abs(s.electricPower))} MWe` : `${fmt(s.electricPower / 10, 1)}% of nominal`);
  setText('neutron-percent', `${smallNumber(s.neutronPower * 100, 1)}% neutron power`);
  setText('primary-temp-label', `Hot leg ${fmt(s.hotLegTemp, 1)} °C`);
  setText('decay-label', s.electricPower < 0 ? 'Transient ratio · net import' : 'Instantaneous power ratio');
  setBar('net-bar', s.electricPower / 10);
  setBar('thermal-bar', s.thermalPower / 30);
  setBar('pressure-bar', s.primaryPressure / 18 * 100);
  setBar('efficiency-bar', s.efficiency / 40 * 100);
  const equipment = {
    'd-primary-pressure': `${fmt(s.primaryPressure, 2)} MPa`,
    'd-reactor': `${fmt(s.thermalPower)} MWth`,
    'd-fuel': `Fuel ${fmt(s.fuelTemp)} °C`,
    'd-hot': `${fmt(s.hotLegTemp, 1)} °C`,
    'd-cold': `${fmt(s.coldLegTemp, 1)} °C`,
    'd-steam-pressure': `${fmt(s.steamPressure, 2)} MPa · ${fmt(s.steamTemp)} °C`,
    'd-level': `${fmt(s.steamLevel, 1)}%`,
    'd-steam-flow': `${fmt(s.steamFlow)} kg/s steam`,
    'd-valve': `${fmt(s.turbineValve * 100)}% valve`,
    'd-bypass': `Bypass ${fmt(s.bypassSteamFlow)} kg/s`,
    'd-grid-state': s.gridConnected === false ? 'Breaker open' : 'To grid',
    'd-rpm': `${fmt(s.turbineSpeed)} rpm`,
    'd-net': `${fmt(s.electricPower)} MWe`,
    'd-condenser': `${fmt(s.condenserPressure, 2)} kPa`,
    'd-feed': `${fmt(s.feedFlow)} kg/s`,
    'm-core': `${fmt(s.thermalPower)} MWth`,
    'm-core-sub': `Fuel ${fmt(s.fuelTemp)} °C`,
    'm-primary': `${fmt(s.primaryPressure, 2)} MPa`,
    'm-primary-sub': `Hot leg ${fmt(s.hotLegTemp, 1)} °C`,
    'm-sg': `${fmt(s.steamPressure, 2)} MPa`,
    'm-sg-sub': `Inventory ${fmt(s.steamLevel, 1)}%`,
    'm-turbine': `${fmt(s.electricPower)} MWe`,
    'm-turbine-sub': `${fmt(s.turbineSpeed)} rpm`,
    'm-condenser': `${fmt(s.condenserPressure, 2)} kPa`,
    'm-feed': `${fmt(s.feedFlow)} kg/s`,
    'fuel-reading': `${fmt(s.fuelTemp, 1)} °C`,
    'reactivity-reading': `${fmt(s.reactivity, 1)} pcm`,
    'decay-reading': `${fmt(s.decayPower, 2)} MW`,
    'xenon-reading': `${fmt(s.xenon, 3)} ×`,
    'flow-reading': `${fmt(s.primaryFlow)} kg/s`,
    'condenser-reading': `${fmt(s.condenserPressure, 2)} kPa`,
    'gross-reading': `${fmt(s.grossPower)} MWe`,
  };
  for (const [id, value] of Object.entries(equipment)) setText(id, value);
  const level = Math.min(100, Math.max(0, s.steamLevel)) / 100;
  $('level-fill').setAttribute('height', String(level * 29));
  $('level-fill').setAttribute('y', String(186 - level * 29));
  $('grid-breaker').setAttribute('d', s.gridConnected === false ? 'M807 88 L831 68' : 'M807 88 L839 88');
  diagram.update(s, { paused, hidden: document.hidden });
  setText('balance-reading', `Thermal balance residual ${fmt(s.energyResidual, 3)} MW`);
  const status = $('plant-status');
  const abnormal = s.alarms?.length > 0;
  status.classList.toggle('tripped', Boolean(s.tripped || s.domainExceeded));
  status.classList.toggle('warning', !s.tripped && !s.domainExceeded && abnormal);
  status.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  status.append(dot, document.createTextNode(s.domainExceeded ? 'Outside model domain' : s.tripped ? 'Reactor tripped' : s.startupMode && s.startupStage !== 'power' ? STAGE_LABELS[s.startupStage] || 'Startup' : abnormal ? 'Active annunciation' : 'Normal operation'));
  $('reset-trip').disabled = !s.tripped || Boolean(s.domainExceeded);
  $('scram').disabled = Boolean(s.tripped || s.domainExceeded);
  renderAlarms(s);
  renderEvents(s);
  renderStartup(s);
}

function renderStartup(s) {
  const active = Boolean(s.startupMode);
  $('startup-workflow').hidden = !active;
  const stage = s.startupStage;
  const signature = JSON.stringify([active, stage, s.startupStatus, s.startupPermissives, s.domainExceeded]);
  if (signature !== startupSignature) {
    startupSignature = signature;
    setText('cold-initialize', active ? 'Restart cold experiment ↶' : 'Initialize cold shutdown ↶');
    setText('startup-intro', active ? 'Reactor-assisted heat-up of a generic plant. Each action changes modeled controls; temperatures, pressure, and rotor speed evolve through the engine.' : 'Start from cold shutdown. Establish circulation, heat the coupled plant, bring the turbine to speed, and connect the generator.');
    const index = STARTUP_STAGES.indexOf(stage);
    for (const item of document.querySelectorAll('[data-stage]')) {
      const itemIndex = STARTUP_STAGES.indexOf(item.dataset.stage);
      item.classList.toggle('current', itemIndex === index);
      item.classList.toggle('complete', itemIndex < index);
      if (itemIndex === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    }
    const message = s.startupStatus || STAGE_LABELS[stage] || 'Awaiting startup state.';
    if ($('startup-status').textContent !== message) setText('startup-status', message);
    for (const button of document.querySelectorAll('[data-startup-action]')) {
      const action = button.dataset.startupAction;
      const permissive = s.startupPermissives?.[action];
      const allowed = Boolean(permissive?.allowed) && !s.domainExceeded;
      button.disabled = !allowed;
      button.closest('.startup-action')?.classList.toggle('permitted', allowed);
      const reason = permissive?.reason || (allowed ? 'Permissives satisfied.' : 'Not available in the current stage.');
      button.title = reason;
      const reasonElement = $(`permissive-${action}`);
      if (reasonElement) reasonElement.textContent = reason;
    }
    $('startup-power').disabled = !['cold', 'prepared', 'heatup'].includes(stage) || Boolean(s.domainExceeded);
    $('scenario-load').disabled = active && stage !== 'power';
  }
  if (!active) return;
  setText('startup-coolant', `${fmt(s.coolantTemp, 1)} °C`);
  setText('startup-neutrons', smallNumber(s.neutronPower, 4));
  setText('startup-rpm', `${fmt(s.turbineSpeed)} rpm`);
  setText('startup-grid', s.gridConnected ? 'Connected' : 'Open');
  setText('startup-target', `Target ${smallNumber(s.heatupTarget * 3000, 1)} MWth · rate ${fmt(s.heatupRateCPerHour, 1)} °C/h`);
  setText('startup-aux-heat', `${smallNumber(s.auxiliaryHeatMW, 2)} MW`);
}

function renderAlarms(s) {
  const alarms = s.alarms || [];
  const signature = JSON.stringify(alarms);
  if (signature === alarmSignature) return;
  alarmSignature = signature;
  setText('alarm-count', String(alarms.length));
  $('alarm-count').classList.toggle('has-alarms', alarms.length > 0);
  const list = $('alarm-list');
  list.replaceChildren();
  if (!alarms.length) {
    const row = document.createElement('div');
    row.className = 'all-clear';
    const icon = document.createElement('span'); icon.className = 'clear-icon'; icon.textContent = '✓';
    const text = document.createElement('div'); text.append(document.createTextNode('All monitored limits normal'));
    const sub = document.createElement('small'); sub.textContent = 'No active alarms'; text.append(sub);
    row.append(icon, text); list.append(row); return;
  }
  for (const alarm of alarms) {
    const row = document.createElement('div'); row.className = `alarm-row ${alarm.level === 'critical' ? 'critical' : ''}`;
    const icon = document.createElement('span'); icon.className = 'alarm-symbol'; icon.textContent = alarm.level === 'critical' ? '■' : '▲';
    const message = document.createElement('span'); message.textContent = alarm.message;
    row.append(icon, message); list.append(row);
  }
}
function renderEvents(s) {
  const events = s.events || [];
  const signature = JSON.stringify(events);
  if (signature === eventSignature) return;
  eventSignature = signature;
  setText('event-count', `${events.length} EVENT${events.length === 1 ? '' : 'S'}`);
  const list = $('event-list'); list.replaceChildren();
  if (!events.length) {
    const row = document.createElement('div'); row.className = 'empty-event'; row.textContent = 'Plant initialized. Changes and protection actions appear here.'; list.append(row); return;
  }
  for (const event of events.slice(-40).reverse()) {
    const row = document.createElement('div'); row.className = `event-row ${['warning', 'critical'].includes(event.level) ? event.level : ''}`;
    const time = document.createElement('span'); time.className = 'event-time'; time.textContent = clock(event.time);
    const indicator = document.createElement('span'); indicator.className = 'event-indicator'; indicator.setAttribute('aria-hidden', 'true');
    const message = document.createElement('span'); message.className = 'event-message'; message.textContent = event.message;
    row.append(time, indicator, message); list.append(row);
  }
}

function svgElement(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}
function chartPoints(points, key, columns) {
  if (points.length <= columns * 4) return points.filter(p => Number.isFinite(p[key]));
  // Preserve extrema in each horizontal pixel bucket, including sharp trip peaks.
  // Exported CSV remains the original 1 Hz data, never this display reduction.
  const stride = Math.ceil(points.length / columns);
  const reduced = [];
  for (let i = 0; i < points.length; i += stride) {
    const bucket = points.slice(i, i + stride).filter(p => Number.isFinite(p[key]));
    if (!bucket.length) continue;
    let min = bucket[0], max = bucket[0];
    for (const point of bucket) { if (point[key] < min[key]) min = point; if (point[key] > max[key]) max = point; }
    const selected = [...new Set([bucket[0], min, max, bucket.at(-1)])].sort((a, b) => a.time - b.time);
    reduced.push(...selected);
  }
  return reduced;
}
function chart(id, series, minDefault, maxDefault) {
  const svg = $(id);
  const width = Math.max(160, svg.clientWidth);
  const height = svg.clientHeight || 158;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const left = width < 240 ? 31 : 38, right = 7, top = 10, bottom = 25;
  const plotW = width - left - right, plotH = height - top - bottom;
  const duration = Number($('history-window').value);
  const tNow = lastSnapshot.time;
  const end = Math.max(10, tNow);
  const start = Math.max(0, end - duration);
  const points = history.filter((p, index) => index >= historyOffset && p.time >= start);
  let low = minDefault, high = maxDefault;
  for (const p of points) for (const line of series) if (Number.isFinite(p[line.key])) { low = Math.min(low, p[line.key]); high = Math.max(high, p[line.key]); }
  const span = high - low || 1;
  low = low < 0 ? low - span * .05 : Math.max(0, low - span * .05);
  high += span * .05;
  const x = (t) => left + (t - start) / (end - start || 1) * plotW;
  const y = (v) => top + (high - v) / (high - low) * plotH;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 4; i++) {
    const v = low + (high - low) * i / 3, yy = y(v);
    frag.append(svgElement('line', { x1: left, x2: width - right, y1: yy, y2: yy, class: 'chart-grid' }));
    const text = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(high - low) < 30 ? v.toFixed(1) : Math.round(v);
    frag.append(svgElement('text', { x: left - 7, y: yy + 3, 'text-anchor': 'end', class: 'chart-axis' }, text));
  }
  const tickCount = duration >= 3600 && width < 300 ? 2 : 3;
  for (let i = 0; i < tickCount; i++) {
    const t = start + (end - start) * i / (tickCount - 1);
    const label = duration >= 3600 ? clock(t) : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    frag.append(svgElement('text', { x: x(t), y: height - 7, 'text-anchor': i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle', class: 'chart-axis' }, label));
  }
  for (const line of series) {
    const valid = chartPoints(points, line.key, Math.max(80, Math.ceil(plotW)));
    if (!valid.length) continue;
    const path = valid.map((p, index) => `${index ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(p[line.key]).toFixed(2)}`).join(' ');
    frag.append(svgElement('path', { d: path, stroke: line.color, class: 'chart-line' }));
    const last = valid.at(-1);
    frag.append(svgElement('circle', { cx: x(last.time), cy: y(last[line.key]), r: 2.2, fill: line.color }));
  }
  svg.replaceChildren(frag);
}
function renderCharts() {
  const starting = lastSnapshot.startupMode && lastSnapshot.startupStage !== 'power';
  chart('chart-power', [{ key: 'thermalPower', color: COLORS.amber }, { key: 'electricPower', color: COLORS.cyan }], 0, starting ? Math.max(50, (lastSnapshot.heatupTarget || .01) * 3600) : 3200);
  chart('chart-temperature', [{ key: 'hotLegTemp', color: COLORS.cyan }, { key: 'coldLegTemp', color: COLORS.blue }], starting ? 20 : 260, 340);
  chart('chart-pressure', [{ key: 'primaryPressure', color: COLORS.cyan }, { key: 'steamPressure', color: COLORS.amber }], 0, 17);
  const count = history.length - historyOffset;
  setText('history-count', `${fmt(count)} sample${count === 1 ? '' : 's'} · 24 h capacity · time ${Number($('history-window').value) >= 3600 ? 'hh:mm:ss' : 'mm:ss'}`);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function initialize() {
  const cold = $('initial-condition').value === 'cold';
  mutate(() => {
    plant.reset(cold ? { mode: 'cold' } : { initialPower: Number($('initial-condition').value) });
    resetHistory(plant.snapshot()); accumulator = 0;
    setPaused(cold);
    $('history-window').value = cold ? '43200' : '300';
    setText('scenario-description', 'Start with a load change, or introduce a disturbance and observe the coupled response.');
  }, cold ? 'Cold shutdown initialized and paused. Establish circulation, then run the model to satisfy the heat-up permissives.' : 'New equilibrium initialized. Previous trend history has been cleared.');
}

for (const input of document.querySelectorAll('[data-control]')) {
  input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
    const key = input.dataset.control;
    const value = input.type === 'checkbox' ? input.checked : key === 'rodReactivity' ? Number(input.value) : Number(input.value) / 100;
    mutate(() => plant.setControl(key, value));
  });
}
$('play-pause').addEventListener('click', () => {
  if (paused && plant.snapshot().domainExceeded) { notify('Initialize a new experiment to leave the model validity boundary.'); return; }
  setPaused(!paused);
});
$('speed').addEventListener('change', () => { speed = Number($('speed').value); accumulator = 0; });
$('cold-initialize').addEventListener('click', () => { $('initial-condition').value = 'cold'; initialize(); });
for (const button of document.querySelectorAll('[data-startup-action]')) button.addEventListener('click', () => {
  mutate(() => {
    const result = plant.startupAction(button.dataset.startupAction);
    if (!result?.ok) throw new Error(result?.message || 'Startup permissives are not satisfied.');
    notify(result.message || 'Startup action applied.');
  });
});
$('scram').addEventListener('click', () => mutate(() => plant.scram('Manual reactor trip'), 'Reactor trip applied. Observe the prompt power decrease and continuing decay heat.'));
$('reset-trip').addEventListener('click', () => {
  mutate(() => {
    if (!plant.resetTrip()) throw new Error('Trip reset conditions are not met. Restore equipment and inspect active limits.');
    notify('Trip latch reset. Regulation is available under the model’s restart conditions.');
  });
});
$('scenario-load').addEventListener('click', () => mutate(() => {
  plant.setControl('autoReactor', true); plant.setControl('autoTurbine', true); plant.setControl('demand', .75);
  setText('scenario-description', 'Load maneuver: demand is now 75%. Watch reactor heat, steam conditions, and net generation find a new balance.');
}, 'Electrical load demand set to 750 MWe.'));
for (const button of document.querySelectorAll('[data-fault]')) button.addEventListener('click', () => {
  const key = button.dataset.fault;
  const enabled = !plant.snapshot().faults[key];
  mutate(() => {
    plant.setFault(key, enabled);
    setText('scenario-description', enabled ? faultDescriptions[key] : 'Equipment restored. Any reactor trip remains latched until reset conditions are satisfied.');
  }, enabled ? faultDescriptions[key] : 'Equipment restored. The trip latch, if set, remains active.');
});
$('restore-faults').addEventListener('click', () => mutate(() => {
  for (const key of FAULTS) plant.setFault(key, false);
  setText('scenario-description', 'All injected equipment faults cleared. Check alarms before attempting to reset a reactor trip.');
}, 'Injected equipment faults cleared. Reactor trip status is unchanged.'));
$('initialize').addEventListener('click', initialize);
$('history-window').addEventListener('change', renderCharts);
$('save-state').addEventListener('click', () => {
  const state = { format: 'openpwr-session', version: 1, model: plant.exportState(), simulationSpeed: speed, paused };
  download(`openpwr-state-${Math.floor(lastSnapshot.time)}s.json`, JSON.stringify(state, null, 2), 'application/json');
  notify('Complete model state exported. Trend samples are available separately as CSV.');
});
$('load-state').addEventListener('click', () => $('state-file').click());
$('state-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('State file exceeds 5 MB.');
    const data = JSON.parse(await file.text());
    const isSession = data.format === 'openpwr-session';
    if (isSession && data.version !== 1) throw new Error('Unsupported session version.');
    plant.importState(isSession ? data.model : data);
    if (isSession && SPEEDS.includes(data.simulationSpeed)) {
      speed = data.simulationSpeed;
      $('speed').value = String(speed);
    }
    lastSnapshot = plant.snapshot();
    resetHistory(lastSnapshot);
    $('initial-condition').value = lastSnapshot.startupMode ? 'cold' : '1';
    setPaused(true);
    syncControls(lastSnapshot); render(lastSnapshot); renderCharts();
    notify('State loaded and paused. Press Run to continue. Trend history begins at the imported time.');
  } catch (error) { notify(`State could not be loaded: ${error.message}`, true); }
  event.target.value = '';
});
$('export-csv').addEventListener('click', () => {
  const units = { time: 's', neutronPower: 'fraction', thermalPower: 'MW', electricPower: 'MWe', grossPower: 'MWe', decayPower: 'MW', fuelTemp: 'C', hotLegTemp: 'C', coldLegTemp: 'C', primaryPressure: 'MPa', steamPressure: 'MPa', steamTemp: 'C', steamLevel: 'percent', steamFlow: 'kg_s', feedFlow: 'kg_s', primaryFlow: 'kg_s', condenserPressure: 'kPa', condenserTemp: 'C', turbineSpeed: 'rpm', reactivity: 'pcm', rodReactivity: 'pcm', xenon: 'equilibrium_ratio', iodine: 'equilibrium_ratio', pumpSpeed: 'fraction', turbineValve: 'fraction', energyResidual: 'MW', efficiency: 'percent', tripped: 'boolean', gridConnected: 'boolean', heatupTarget: 'thermal_fraction', heatupRateCPerHour: 'C_per_hour', rotorEnergyMJ: 'MJ', auxiliaryHeatMW: 'MW', sourceStrength: 'normalized_source', startupStage: 'stage' };
  // Include the current observation even when an action happened while paused,
  // before the next 1 Hz sample. Avoid a duplicate timestamp at an exact boundary.
  const samples = history.slice(historyOffset);
  const latest = sample(plant.snapshot());
  if (Math.abs(samples.at(-1).time - latest.time) < 1e-8) samples[samples.length - 1] = latest;
  else samples.push(latest);
  const keys = Object.keys(samples[0]);
  const lines = [keys.map((k) => `${k}_${units[k] || ''}`).join(',')];
  for (const row of samples) {
    lines.push(keys.map((k) => typeof row[k] === 'boolean' ? Number(row[k]) : Number.isFinite(row[k]) ? row[k].toPrecision(12) : typeof row[k] === 'string' ? `"${row[k].replaceAll('"', '""')}"` : '').join(','));
  }
  download(`openpwr-history-${Math.floor(lastSnapshot.time)}s.csv`, lines.join('\n') + '\n', 'text/csv;charset=utf-8');
  notify(`${fmt(samples.length)} samples, including the current state, exported as CSV.`);
});
const dialog = $('model-dialog');
for (const id of ['model-open', 'limits-open']) $(id).addEventListener('click', () => dialog.showModal());
$('model-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
new ResizeObserver(() => renderCharts()).observe($('trends-title').closest('.panel'));
document.addEventListener('visibilitychange', () => { lastFrame = performance.now(); accumulator = 0; });

function frame(now) {
  const elapsed = Math.min(.25, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (!paused && !document.hidden) {
    // A requested speed is a target. Bound work/debt rather than enlarging DT or
    // skipping physical timesteps when a slower device cannot sustain that target.
    accumulator = Math.min(accumulator + elapsed * speed, speed * .5);
    const workStart = performance.now();
    let steps = 0;
    try {
      while (accumulator + 1e-10 >= DT && steps < 5000 && performance.now() - workStart < FRAME_WORK_BUDGET_MS) {
        plant.step(DT); accumulator -= DT; sampleAccumulator += DT;
        steps++;
        if (sampleAccumulator + 1e-10 >= 1) {
          lastSnapshot = plant.snapshot();
          record(lastSnapshot);
          sampleAccumulator -= 1;
          if (lastSnapshot.domainExceeded) { setPaused(true); break; }
        }
      }
    } catch (error) {
      setPaused(true);
      notify(`Simulation paused: ${error.message}`, true);
    }
  }
  if (now - lastPaint > 125) {
    lastSnapshot = plant.snapshot(); render(lastSnapshot); lastPaint = now;
  }
  if (now - lastChartPaint > 500) { renderCharts(); lastChartPaint = now; }
  diagram.update(lastSnapshot, { elapsed, paused, hidden: document.hidden });
  if (now - lastRateWall >= 1000) {
    const actual = Math.max(0, (lastSnapshot.time - lastRateSim) * 1000 / (now - lastRateWall));
    $('speed-achieved').hidden = speed <= 20;
    setText('speed-achieved', paused ? 'Paused' : `Actual ${fmt(actual)}× · target ${fmt(speed)}×`);
    lastRateWall = now; lastRateSim = lastSnapshot.time;
  }
  requestAnimationFrame(frame);
}

syncControls(lastSnapshot);
render(lastSnapshot);
renderCharts();
requestAnimationFrame(frame);
