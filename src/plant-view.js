// SPDX-License-Identifier: Apache-2.0
import { mountPlant3D } from './plant3d.js';

// Both presentations receive the same observations; switching views never changes physics.
export function createPlantView({ host, schematic, mode }) {
  const buttons = [...document.querySelectorAll('[data-plant-view]')];
  let selected = '3d', latest = null, options = {};
  const viewer = mountPlant3D(host, { mode });
  function select(value) {
    selected = value;
    host.hidden = value !== '3d';
    schematic.hidden = value !== 'schematic';
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.plantView === value));
    if (latest) viewer.update(latest, { ...options, hidden: Boolean(options.hidden || host.hidden) });
  }
  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.plantView));
  select(selected);
  return {
    update(snapshot, nextOptions) {
      latest = snapshot; options = nextOptions;
      viewer.update(snapshot, { ...nextOptions, hidden: Boolean(nextOptions.hidden || selected !== '3d') });
    },
    dispose() { viewer.dispose(); },
  };
}
