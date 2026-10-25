// SPDX-License-Identifier: Apache-2.0
import { diagramState, advancePhase } from './animation-state.js';

// A display-only clock: it never advances, mutates, or feeds back into the plant.
// Wall-time motion stays legible even when physics is running at 1,000x speed.
export function createDiagramAnimation(root = document) {
  const find = id => root.getElementById(id);
  const paths = Object.fromEntries(Object.entries({
    primary: '.primary-flow', steamHeader: '.steam-header-flow', steam: '.steam-flow',
    bypass: '.bypass-flow', feed: '.feed-flow', cooling: '.cooling-flow', grid: '.grid-flow',
  }).map(([key, selector]) => [key, [...root.querySelectorAll(selector)]]));
  const rotors = { primary: [find('primary-rotor'), 251, 288], feed: [find('feed-rotor'), 491, 315],
    turbine: [find('turbine-rotor'), 631, 88], generator: [find('generator-rotor'), 749, 88] };
  const bubbles = [...find('steam-bubbles').children];
  const core = find('core-heat'), shaft = find('shaft-motion');
  const toggle = find('animation-toggle'), status = find('animation-status');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true, lastLabel = '', snapshot, options = {};
  const phases = {};
  function update(s, { elapsed = 0, paused = false, hidden = false } = {}) {
    snapshot = s; options = { paused, hidden };
    const state = diagramState(s);
    const moving = enabled && !preference.matches && !paused && !hidden && !s.domainExceeded;
    const dt = moving ? elapsed : 0;
    for (const [key, elements] of Object.entries(paths)) {
      const rate = state.rates[key];
      phases[key] = advancePhase(phases[key] || 0, rate * 55, dt, 30);
      for (const path of elements) {
        path.style.strokeDashoffset = String(-phases[key]);
        path.style.opacity = Math.abs(rate) < .001 ? '0' : '1';
      }
    }
    for (const [key, [el, x, y]] of Object.entries(rotors)) {
      const phaseKey = `rotor-${key}`;
      phases[phaseKey] = advancePhase(phases[phaseKey] || 0, state.rotors[key] * 100, dt, 360);
      el.setAttribute('transform', `rotate(${phases[phaseKey]} ${x} ${y})`);
      el.classList.toggle('rotor-active', Math.abs(state.rotors[key]) > .001);
    }
    shaft.style.strokeDashoffset = String(-(phases['rotor-turbine'] || 0) / 6);
    shaft.style.opacity = state.rotors.turbine > .001 ? '1' : '0';
    core.style.opacity = String(.08 + .92 * Math.sqrt(state.heat));
    phases.bubbles = advancePhase(phases.bubbles || 0, Math.sqrt(state.steamActivity) * 24, dt, 100);
    for (let i = 0; i < bubbles.length; i++) {
      const position = (phases.bubbles + i * 21) % 100;
      bubbles[i].setAttribute('cy', String(243 - position));
      bubbles[i].style.opacity = state.steamActivity < .001 ? '0' : String(Math.min(1, position / 10, (100 - position) / 15) * .85);
    }
    const label = preference.matches ? 'Reduced motion · system preference' : !enabled ? 'Animation off' : paused || s.domainExceeded ? 'Motion paused with simulation' : hidden ? 'Motion suspended' : 'Live motion · follows plant state';
    if (label !== lastLabel) { status.textContent = label; lastLabel = label; }
    toggle.textContent = preference.matches ? 'Reduced motion' : enabled ? 'Animation on' : 'Animation off';
    toggle.setAttribute('aria-pressed', String(enabled && !preference.matches));
    toggle.disabled = preference.matches;
  }
  toggle.addEventListener('click', () => { enabled = !enabled; if (snapshot) update(snapshot, options); });
  preference.addEventListener('change', () => { if (snapshot) update(snapshot, options); });
  return { update };
}
