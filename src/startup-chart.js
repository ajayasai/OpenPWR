// SPDX-License-Identifier: Apache-2.0
const powerFormat = new Intl.NumberFormat('en', {maximumFractionDigits: 2});
const measuredNumber = new Intl.NumberFormat('en', {maximumFractionDigits: 3});

export function svgElement(tag, attributes, value) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, val);
  if (value !== undefined) element.textContent = value;
  return element;
}

export function historicalAxes(chart, xmin, xmax, values, unit, uncoveredAfter, roundedTicks = false) {
  // Size the coordinate system for the actual column so mobile axis labels remain legible.
  const width = Math.max(260, Math.round(chart.getBoundingClientRect().width || 540));
  chart.setAttribute('viewBox', `0 0 ${width} 220`);
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * .08, .01);
  const divisions = width < 400 ? 3 : 4;
  let firstTick = low - pad, lastTick = high + pad, rowCount = divisions;
  if (roundedTicks) {
    const target = Math.max(high - low, .1) / divisions;
    const magnitude = 10 ** Math.floor(Math.log10(target));
    const step = magnitude * [1, 2, 2.5, 5, 10].find(n => n * magnitude >= target);
    firstTick = Math.floor(low / step) * step;
    lastTick = Math.max(firstTick + step, Math.ceil(high / step) * step);
    rowCount = Math.round((lastTick - firstTick) / step);
  }
  const left = 50, right = width - 22, top = 27, bottom = 174;
  const x = s => left + (right - left) * (s - xmin) / (xmax - xmin);
  const y = value => bottom - (bottom - top) * (value - firstTick) / (lastTick - firstTick);
  chart.replaceChildren();
  if (Number.isFinite(uncoveredAfter) && xmax > uncoveredAfter) chart.append(svgElement('rect', {
    x: x(uncoveredAfter), y: top, width: right - x(uncoveredAfter), height: bottom - top, class: 'uncovered',
  }));
  chart.append(svgElement('text', {x: left, y: 16}, unit));
  for (let i = 0; i <= rowCount; i++) {
    const value = firstTick + (lastTick - firstTick) * i / rowCount;
    chart.append(svgElement('line', {x1: left, x2: right, y1: y(value), y2: y(value), class: 'grid-line'}),
      svgElement('text', {x: left - 5, y: y(value) + 4, 'text-anchor': 'end'}, measuredNumber.format(value)));
  }
  for (let i = 0; i <= divisions; i++) {
    const time = xmin + (xmax - xmin) * i / divisions;
    chart.append(svgElement('text', {x: x(time), y: bottom + 16, 'text-anchor': 'middle'}, powerFormat.format(time / 3600)));
  }
  chart.append(svgElement('text', {x: (left + right) / 2, y: 211, 'text-anchor': 'middle'}, 'Elapsed time (hours)'));
  return {x, y, top, bottom, left, right};
}

export function historicalTrace(chart, samples, x, y, className) {
  const trace = samples.map((p, i) => (i ? 'L' : 'M') + x(p.elapsedS).toFixed(2) + ' ' + y(p.value).toFixed(2)).join(' ');
  chart.append(svgElement('path', {d: trace, class: className}));
}

export async function fetchComparison(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
