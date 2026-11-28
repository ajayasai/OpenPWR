// SPDX-License-Identifier: Apache-2.0
import { fetchComparison, historicalAxes, historicalTrace, svgElement } from './startup-chart.js';

const element = name => document.getElementById('ol-' + name);
const format = new Intl.NumberFormat('en', {maximumFractionDigits: 3});
const units = {primaryPressureMPa: 'MPa abs', averageCoolantTemperatureC: '°C', power: '% rated'};
const timeLabel = seconds => {
  const hours = Math.floor(seconds / 3600), minutes = seconds % 3600 / 60;
  return minutes ? hours + ' h ' + minutes + ' min' : hours + ' h';
};

async function openEvidence() {
  const [report, native] = await Promise.all([
    fetchComparison('./open-loop-startup.json'), fetchComparison('./open-loop-startup-native.json'),
  ]);
  if (report.schema !== 'openpwr-native-open-loop-validation-v1' || native.observationsUsed !== 0 ||
      native.trajectory?.length !== report.nativeSamples || native.reportIntervalSeconds !== 300) {
    throw new Error('The files identify incompatible forecast runs.');
  }
  const byEvent = element('event'), byChannel = element('channel'), windowSelect = element('window');
  const jump = element('jump'), slider = element('time'), chart = element('chart'), play = element('play');
  const trajectory = native.trajectory, interval = native.reportIntervalSeconds;
  const fineRun = native.nativeRuns.find(run => run.stepSeconds === native.forecastCommunicationStepSeconds);
  const event = () => report[byEvent.value];
  const predicted = row => byChannel.value === 'power' ? row.netPowerMW / 1000 * 100 : row[byChannel.value];
  const observed = row => byChannel.value === 'power'
    ? (row.stationGrossLoadFraction == null ? null : row.stationGrossLoadFraction * 100)
    : row.station[byChannel.value];
  let axes, cursor, marker, observations, timer;

  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = 'Play';
  }
  function inspect() {
    const point = trajectory[Number(slider.value)], seconds = point.elapsedS;
    const row = observations.get(seconds), value = row && observed(row);
    const label = timeLabel(seconds), unit = units[byChannel.value];
    element('elapsed').textContent = label;
    element('native-value').textContent = format.format(predicted(point)) + ' ' + unit;
    element('station-value').textContent = Number.isFinite(value) ? format.format(value) + ' ' + unit
      : row ? 'Unavailable in bulletin' : 'No reading at this time';
    element('grid').textContent = point.gridConnected ? (
      fineRun.terminalRatedDwellStartS != null && seconds >= fineRun.terminalRatedDwellStartS
        ? 'Rated power' : 'Grid connected') : 'Offline';
    const source = new URL(event().sourceUrl || (row || event().rows[0]).sourceUrl);
    source.hash = 'page=' + (byEvent.value === 'westinghouse' ? 19 : row?.page || event().rows[0].page);
    element('source').href = source.href;
    slider.setAttribute('aria-valuetext', label + ', native ' + element('native-value').textContent +
      ', station ' + element('station-value').textContent);
    jump.value = row ? String(seconds) : '';
    const x = axes.x(seconds);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
    marker.setAttribute('cx', x); marker.setAttribute('cy', axes.y(predicted(point)));
  }
  function draw() {
    const selection = event(), channel = byChannel.value, unit = units[channel];
    const stationEnd = selection.rows.at(-1).elapsedHours * 3600;
    const end = windowSelect.value === 'native' ? native.durationSeconds : stationEnd;
    slider.max = end / interval;
    if (Number(slider.value) > Number(slider.max)) slider.value = slider.max;
    const samples = trajectory.slice(0, end / interval + 1).map(row => ({elapsedS: row.elapsedS, value: predicted(row)}));
    const readings = selection.rows.filter(row => Number.isFinite(observed(row)));
    axes = historicalAxes(chart, 0, end, [...samples.map(p => p.value), ...readings.map(observed)], unit, stationEnd, true);
    historicalTrace(chart, samples, axes.x, axes.y, 'predicted-line');
    for (const row of readings) {
      const dot = svgElement('circle', {cx: axes.x(row.elapsedHours * 3600), cy: axes.y(observed(row)), r: 3.6, class: 'observed-point'});
      dot.append(svgElement('title', {}, row.elapsedHours + ' h · ' + format.format(observed(row)) + ' ' + unit));
      chart.append(dot);
    }
    cursor = svgElement('line', {y1: axes.top, y2: axes.bottom, class: 'marker'});
    marker = svgElement('circle', {r: 4.4, class: 'point'});
    chart.append(cursor, marker);
    element('caption').textContent = selection.clock + '. ' + readings.length + ' reported values.' +
      (end > stationEnd ? ' Shading marks time beyond the station record.' : '');
    const scores = selection.scores[channel];
    element('score-title').textContent = scores ? 'Forecast error' : 'Power comparison';
    element('score').textContent = scores
      ? 'Across ' + scores.native.n + ' readings after hour zero, root-mean-square error is ' + format.format(scores.native.rmse) + ' ' + unit +
        ' for the native forecast and ' + format.format(scores.originPersistence.rmse) + ' ' + unit +
        ' for holding the initial station reading fixed. Mean native error is ' + format.format(scores.native.bias) + ' ' + unit + '.'
      : 'Power is shown for context. The station reports gross generator output relative to 1,180 MW. The native run reports net output relative to 1,000 MW.';
    const milestones = element('milestones');
    milestones.hidden = channel !== 'power' || !report.milestones;
    if (!milestones.hidden) {
      const m = report.milestones;
      milestones.textContent = 'Grid connection occurred at ' + format.format(m.ohiGridConnectionHours) + ' h at Ōi and ' +
        format.format(m.nativeGridConnectionHours) + ' h in the model. Ōi reached rated thermal power at ' +
        format.format(m.ohiRatedThermalHours) + ' h. The model sustained its rated operating range from ' +
        format.format(m.nativeSustainedRatedEnvelopeStartHours) + ' h.';
    }
    const ohi = byEvent.value === 'ohi';
    element('coverage').textContent = selection.measuredScope + '. ' + (ohi
      ? 'Pressure uses the gauge-to-absolute conversion. The bulletin’s primary coolant temperature is compared with the model’s mean of its hot and cold legs. Daily snapshots leave the response between readings unobserved.'
      : 'This record ends at no load. The plotted coolant temperature averages the measured hot and cold legs.');
    inspect();
  }
  function switchEvent() {
    stop();
    const rows = event().rows;
    byChannel.querySelector('option[value="power"]').disabled = byEvent.value !== 'ohi';
    if (byEvent.value !== 'ohi' && byChannel.value === 'power') byChannel.value = 'primaryPressureMPa';
    observations = new Map(rows.map(row => [row.elapsedHours * 3600, row]));
    jump.replaceChildren(new Option('Select time…', ''), ...rows.map(row =>
      new Option(timeLabel(row.elapsedHours * 3600) + (row.timestamp ? ' · ' + row.timestamp.slice(0, 10) : ''), row.elapsedHours * 3600)));
    slider.value = 0;
    draw();
  }
  byEvent.addEventListener('change', switchEvent);
  for (const control of [byChannel, windowSelect]) control.addEventListener('change', () => { stop(); draw(); });
  slider.addEventListener('input', () => { stop(); inspect(); });
  jump.addEventListener('change', () => {
    stop();
    if (jump.value !== '') slider.value = Number(jump.value) / interval;
    inspect();
  });
  play.addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (slider.value === slider.max) slider.value = 0;
    const start = Number(slider.value), max = Number(slider.max), started = performance.now();
    play.textContent = 'Pause';
    inspect();
    timer = setInterval(() => {
      slider.value = Math.min(max, start + Math.floor((performance.now() - started) * max / 20000));
      inspect();
      if (Number(slider.value) === max) stop();
    }, 100);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  element('results').hidden = false;
  element('status').textContent = '';
  switchEvent();
  new ResizeObserver(([entry]) => {
    if (Math.abs(entry.contentRect.width - chart.viewBox.baseVal.width) >= 1) draw();
  }).observe(chart);
}

openEvidence().catch(error => {
  element('results').hidden = true;
  element('status').textContent = 'Unable to load the open-loop comparison. ' + error.message;
  element('status').classList.add('error');
});
