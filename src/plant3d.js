// SPDX-License-Identifier: Apache-2.0
import { plant3DState, advanceVisualPhase, visualMotionAllowed } from './plant3d-state.js';

// Original, deliberately generic equipment geometry. This is a view of supplied
// model observations, never a source of plant state or engineering dimensions.
const COMPONENTS = {
  auxiliary: { name: 'Auxiliary feedwater', short: 'AUXILIARY FEEDWATER', position: [6.7, 1.8, 5.3], label: [6.7, 4.3, 5.3],
    description: 'Two motor-driven trains draw from a finite water tank. Rotor speed, branch flow and tank level follow separate native solver observations; isolated valves can stop flow while a pump still turns.',
    rows: [['Tank inventory', 'auxTankMass', 'kg', 0], ['Tank level', 'auxTankLevel', '%', 1], ['Tank temperature', 'auxTankTemperature', '°C', 1], ['Train A flow', 'auxAFlow', 'kg/s', 1], ['Train B flow', 'auxBFlow', 'kg/s', 1], ['Pump electrical load', 'auxPumpPower', 'MW', 3]], metric: ['auxFlow', 'kg/s', 1] },
  reactor: { name: 'Reactor vessel', short: 'REACTOR', position: [-5, 3, 0], label: [-5, 6.3, 0],
    description: 'Cut away the pressure vessel to inspect the core, upper internals and coolant paths. Core color follows the displayed model thermal power.',
    rows: [['Thermal power', 'thermalPower', 'MWth', 0], ['Fuel temperature', 'fuelTemperature', '°C', 1], ['Hot-leg temperature', 'hotTemperature', '°C', 1], ['Primary pressure', 'pressure', 'MPa', 2]], metric: ['thermalPower', 'MWth', 0] },
  steamGenerator: { name: 'Steam generator', short: 'STEAM GENERATOR', position: [2, 3.5, 0], label: [2, 8.3, 0],
    description: 'The U-tube bundle transfers heat across separate primary and secondary circuits. Equipment geometry is illustrative.',
    rows: [['Heat transferred', 'heatToSteam', 'MW', 0], ['Secondary temperature', 'steamTemperature', '°C', 1], ['Steam pressure', 'steamPressure', 'MPa', 2], ['Secondary level', 'steamLevel', '%', 1]], metric: ['heatToSteam', 'MW', 0] },
  pressurizer: { name: 'Pressurizer', short: 'PRESSURIZER', position: [-1.5, 5.4, -4], label: [-1.5, 8.7, -4],
    description: 'The surge line connects the primary loop to the pressurizer. Only the native model supplies liquid inventory, heater and spray readings.',
    rows: [['Pressure', 'pressure', 'MPa', 2], ['Liquid level', 'pressurizerLevel', '%', 1], ['Heater input', 'heaterPower', 'MW', 2], ['Spray input', 'sprayFlow', 'kg/s', 1]], metric: ['pressure', 'MPa', 2] },
  pump: { name: 'Primary coolant pump', short: 'COOLANT PUMP', position: [-.3, 1.6, 3.5], label: [-.3, 3.2, 3.5],
    description: 'Rotor motion follows actual modeled pump speed. Flow tracers follow loop mass flow, including natural circulation after coastdown.',
    rows: [['Primary mass flow', 'primaryFlow', 'kg/s', 0], ['Pump speed', 'pumpSpeed', 'fraction', 3], ['Cold-leg temperature', 'coldTemperature', '°C', 1]], metric: ['primaryFlow', 'kg/s', 0] },
  turbine: { name: 'Steam turbine', short: 'TURBINE', position: [9, 2.1, 1], label: [9, 4.0, 1],
    description: 'The visible shaft and blade stages follow modeled turbine speed. Steam tracers follow turbine admission flow.',
    rows: [['Shaft speed', 'turbineSpeed', 'rpm', 0], ['Admission flow', 'turbineSteamFlow', 'kg/s', 0], ['Steam temperature', 'steamTemperature', '°C', 1], ['Bypass flow', 'bypassSteamFlow', 'kg/s', 0]], metric: ['turbineSpeed', 'rpm', 0] },
  generator: { name: 'Electrical generator', short: 'GENERATOR', position: [14, 2.1, 1], label: [14, 4.0, 1],
    description: 'Generator rotation follows the turbine shaft. The output lead is animated only when the model reports a closed grid breaker and gross power.',
    rows: [['Net plant output', 'electricPower', 'MWe', 0], ['Gross generator output', 'grossPower', 'MWe', 0], ['Shaft speed', 'turbineSpeed', 'rpm', 0]], metric: ['electricPower', 'MWe', 0] },
  condenser: { name: 'Condenser & heat sink', short: 'CONDENSER', position: [9, 1.2, -5], label: [9, 3.0, -5],
    description: 'Cooling-water paths carry heat to the external sink. Cooling tracers stop on a modeled loss of heat sink; no condenser inventory is invented.',
    rows: [['Condenser pressure', 'condenserPressure', 'kPa', 2], ['Condenser temperature', 'condenserTemperature', '°C', 1], ['Feedwater flow', 'feedFlow', 'kg/s', 0]], metric: ['condenserPressure', 'kPa', 2] },
};
const CORE_IDS = ['reactor', 'steamGenerator', 'pressurizer', 'pump'];
const fmt = (value, digits = 0) => value === null ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function mountPlant3D(host, { mode = 'browser' } = {}) {
  if (!host?.appendChild) throw new TypeError('A 3D viewer host element is required');
  if (!['browser', 'native', 'plant'].includes(mode)) throw new TypeError('Unknown 3D observation source');
  const native = mode === 'native';
  const ids = native ? CORE_IDS : Object.keys(COMPONENTS).filter(id => mode === 'plant' || id !== 'auxiliary');
  const root = document.createElement('section'); root.className = 'p3d';
  root.setAttribute('aria-label', native ? 'Interactive 3D primary-loop observation view' : 'Interactive 3D plant observation view');
  root.innerHTML = `<div class="p3d-toolbar"><div class="p3d-title"><span class="p3d-title-icon" aria-hidden="true">◇</span><div><strong>${native ? 'Primary loop · spatial view' : 'Plant systems · spatial view'}</strong><small>${mode !== 'browser' ? 'OPENMODELICA OBSERVATIONS' : 'BROWSER MODEL OBSERVATIONS'} · THREE.JS</small></div></div><div class="p3d-tools"><label><span>Camera</span><select data-camera aria-label="3D camera preset"><option value="overview">Overview</option><option value="primary">Primary circuit</option><option value="reactor">Core detail</option>${native ? '' : '<option value="turbine">Turbine hall</option>'}<option value="top">Plan view</option></select></label><button type="button" data-cutaway aria-pressed="true">Cutaway</button><button type="button" data-flow aria-pressed="true">Flow</button><button type="button" data-label-toggle aria-pressed="true">Labels</button></div></div>
    <div class="p3d-body"><div class="p3d-viewport"><div class="p3d-hud"><span class="p3d-status" role="status">Loading 3D view</span><span class="p3d-clock">t — s</span></div><div class="p3d-labels"></div><div class="p3d-help"><strong>Preparing the spatial view</strong>Loading the local open-source renderer.</div><div class="p3d-scale"><span>Generic arrangement · not to scale</span><span>Flow and rotation are visual cues</span></div></div><aside class="p3d-inspector" aria-label="Selected equipment observations"><span class="p3d-eyebrow">Equipment inspector</span><select data-equipment aria-label="Inspect equipment">${ids.map(id => `<option value="${id}">${COMPONENTS[id].name}</option>`).join('')}</select><h3 class="p3d-component-title"></h3><p class="p3d-component-description"></p><dl class="p3d-readings"></dl><button type="button" class="p3d-focus">Focus selected equipment</button><p class="p3d-scope">${native ? 'Primary loop + pressurizer only. Reactor heat is an input; secondary temperature is a boundary. No turbine, kinetics or electrical model is represented here.' : mode === 'plant' ? 'Coupled native hot-plant observations: core, primary, secondary, turbine and condenser. Generic geometry; measured-validation scope is documented separately.' : 'Reduced-order plant observations. Pressurizer liquid inventory is not modeled in this engine. Geometry does not establish plant-specific fidelity.'}</p></aside></div>
    <div class="p3d-footer"><div class="p3d-legend"><span><i style="--line-color:#f6ac67"></i>Hot primary</span><span><i style="--line-color:#66b7ff"></i>Cold primary</span>${native ? '<span><i style="--line-color:#c4dfdf"></i>Secondary boundary</span>' : '<span><i style="--line-color:#e0e8dd"></i>Steam</span><span><i style="--line-color:#66d9c8"></i>Water / cooling</span>'}</div><span class="p3d-instructions">Drag to orbit · scroll/pinch to zoom · click equipment · arrows orbit · + / − zoom</span></div>`;
  host.appendChild(root);
  const $ = selector => root.querySelector(selector);
  const viewport = $('.p3d-viewport'); const labels = $('.p3d-labels');
  const status = $('.p3d-status'); const help = $('.p3d-help');
  const abort = new AbortController(); const on = (element, type, handler, options = {}) => element.addEventListener(type, handler, { ...options, signal: abort.signal });
  let state = plant3DState(null, mode), flags = { paused: true, hidden: false, animate: true };
  let disposed = false, failed = false, selected = 'reactor', cutaway = true, flowVisible = true, labelsVisible = true;
  $('[data-equipment]').value = selected;
  let sceneView = null, inViewport = true, frame = 0, lastFrame = 0, dirty = true;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const labelElements = new Map();
  const readingElements = new Map(); let inspected = null;
  for (const id of ids) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'p3d-label';
    button.setAttribute('aria-label', `Inspect ${COMPONENTS[id].name}`); button.setAttribute('aria-pressed', String(id === selected));
    button.innerHTML = `<strong>${COMPONENTS[id].short}</strong><span>—</span>`;
    on(button, 'click', () => select(id)); labels.appendChild(button); labelElements.set(id, button);
  }
  function read(key) { return state.available ? state.values[key] : null; }
  function inspector() {
    const component = COMPONENTS[selected];
    const rows = native && selected === 'steamGenerator' ? component.rows.slice(0, 2) : component.rows;
    if (inspected !== selected) {
      inspected = selected; readingElements.clear();
      $('.p3d-component-title').textContent = component.name;
      $('.p3d-component-description').textContent = native && selected === 'steamGenerator'
        ? 'The modeled primary-side heat exchanger rejects heat to a prescribed secondary temperature. The secondary water inventory, steam flow and pressure are outside this native model.'
        : mode === 'plant' && selected === 'condenser'
          ? 'The native condenser tracks liquid inventory and temperature. Blue cooling tracers indicate heat transfer to the external sink; cooling-water mass flow is not a modeled state.' : component.description;
      const container = $('.p3d-readings'); container.replaceChildren();
      for (const [label, key, unit] of rows) {
        const row = document.createElement('div'); row.className = 'p3d-reading';
        const dt = document.createElement('dt'); dt.textContent = native && key === 'thermalPower' ? 'Prescribed heat input' : label;
        const dd = document.createElement('dd'); const value = document.createTextNode('— '); dd.append(value);
        const units = document.createElement('small'); units.textContent = unit; dd.appendChild(units);
        row.append(dt, dd); container.appendChild(row); readingElements.set(key, value);
      }
    }
    for (const [, key, , digits] of rows) {
      const value = fmt(read(key), digits) + ' '; const node = readingElements.get(key);
      if (node.nodeValue !== value) node.nodeValue = value;
    }
  }
  function select(id) {
    if (!ids.includes(id)) return;
    selected = id; $('[data-equipment]').value = id;
    for (const [key, element] of labelElements) element.setAttribute('aria-pressed', String(key === id));
    inspector(); sceneView?.select(id); requestRender();
  }
  function updateReadings() {
    inspector(); $('.p3d-clock').textContent = state.available ? `t ${fmt(state.time, 1)} s` : 't — s';
    const still = flags.paused || !flags.animate || reduced.matches;
    if (!failed) {
      status.textContent = !sceneView ? 'Loading 3D view' : !state.available ? 'Waiting for observations' : state.halted ? 'Model halted' : still ? 'Observations · motion paused' : state.tripped ? 'Reactor tripped · coastdown' : 'Live model observations';
      status.dataset.state = state.halted ? 'halted' : state.available && !still ? 'live' : 'waiting';
    }
    for (const [id, element] of labelElements) {
      const [key, unit, digits] = COMPONENTS[id].metric;
      element.querySelector('span').textContent = `${fmt(read(key), digits)} ${unit}`;
    }
  }
  function requestRender() {
    dirty = true;
    if (!disposed && sceneView && inViewport && !flags.hidden && !document.hidden && !frame) frame = requestAnimationFrame(render);
  }
  function render(now) {
    frame = 0;
    if (disposed || !sceneView || !inViewport || flags.hidden || document.hidden) { lastFrame = 0; return; }
    const moving = visualMotionAllowed(state, { ...flags, reducedMotion: reduced.matches });
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : 0;
    if (elapsed > 0 && elapsed < 1 / 30) { frame = requestAnimationFrame(render); return; }
    lastFrame = now;
    try {
      if (dirty || moving) { sceneView.render(state, moving ? elapsed : 0); dirty = false; }
    } catch (error) { fail(error); return; }
    if (moving) frame = requestAnimationFrame(render);
  }
  function fail(error) {
    if (disposed) return;
    failed = true;
    if (frame) cancelAnimationFrame(frame); frame = 0;
    root.dataset.failed = 'true'; status.textContent = '3D unavailable'; status.dataset.state = 'halted';
    help.hidden = false; help.replaceChildren();
    const title = document.createElement('strong'); title.textContent = '3D rendering is unavailable';
    help.append(title, document.createTextNode('This browser needs WebGL 2 for the spatial view. Use the Process schematic to continue inspecting the same model observations.'));
    console.warn('OpenPWR spatial view:', error);
    sceneView?.dispose(); sceneView = null;
  }
  on($('[data-equipment]'), 'change', event => select(event.target.value));
  on($('[data-camera]'), 'change', event => { sceneView?.preset(event.target.value); requestRender(); });
  on($('.p3d-focus'), 'click', () => { sceneView?.focus(selected); requestRender(); });
  on($('[data-cutaway]'), 'click', event => { cutaway = !cutaway; event.currentTarget.setAttribute('aria-pressed', String(cutaway)); sceneView?.cutaway(cutaway); requestRender(); });
  on($('[data-flow]'), 'click', event => { flowVisible = !flowVisible; event.currentTarget.setAttribute('aria-pressed', String(flowVisible)); sceneView?.flow(flowVisible); requestRender(); });
  on($('[data-label-toggle]'), 'click', event => { labelsVisible = !labelsVisible; event.currentTarget.setAttribute('aria-pressed', String(labelsVisible)); labels.hidden = !labelsVisible; requestRender(); });
  on(document, 'visibilitychange', () => { lastFrame = 0; requestRender(); });
  on(reduced, 'change', () => { lastFrame = 0; updateReadings(); requestRender(); });
  const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    inViewport = entries[0].isIntersecting; lastFrame = 0; if (inViewport) requestRender();
  }, { rootMargin: '120px' }) : null;
  intersection?.observe(root);
  let resizeObserver = null;
  const ready = Promise.all([import('./vendor/three/three.module.js'), import('./vendor/three/OrbitControls.js')]).then(([THREE, { OrbitControls }]) => {
    if (disposed) return false;
    sceneView = buildScene(THREE, OrbitControls, viewport, { native, coupled: mode === 'plant', ids, labelElements, on, select, requestRender });
    sceneView.cutaway(cutaway); sceneView.flow(flowVisible); sceneView.select(selected);
    help.hidden = true; updateReadings();
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => { sceneView?.resize(); requestRender(); }); resizeObserver.observe(viewport);
    } else on(window, 'resize', () => { sceneView?.resize(); requestRender(); });
    requestRender(); return true;
  }).catch(error => { fail(error); return false; });
  inspector();
  return {
    ready,
    update(snapshot, options = {}) {
      if (disposed) return;
      state = plant3DState(snapshot, mode); flags = { paused: false, hidden: false, animate: true, ...options };
      updateReadings(); requestRender();
    },
    dispose() {
      if (disposed) return; disposed = true;
      abort.abort(); intersection?.disconnect(); resizeObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame); sceneView?.dispose(); sceneView = null; root.remove();
    },
  };
}

function buildScene(T, OrbitControls, viewport, { native, coupled, ids, labelElements, on, select, requestRender }) {
  const scene = new T.Scene(); scene.background = new T.Color('#111e2b'); scene.fog = new T.Fog('#111e2b', 40, 85);
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFShadowMap;
  const canvas = renderer.domElement; canvas.className = 'p3d-canvas'; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D plant. Drag to orbit, use arrow keys to orbit, plus and minus to zoom. Select equipment with the inspector menu.');
  viewport.prepend(canvas);
  const camera = new T.PerspectiveCamera(40, 1, .1, 120);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = false;
  orbit.minDistance = 5; orbit.maxDistance = 55; orbit.maxPolarAngle = Math.PI * .49;
  orbit.minPolarAngle = .025; orbit.target.set(native ? -1.7 : 4.0, 2.2, 0);
  orbit.addEventListener('change', requestRender);
  const ambient = new T.HemisphereLight('#d0edff', '#25303c', 2.2); scene.add(ambient);
  const key = new T.DirectionalLight('#fff1d7', 3.1); key.position.set(-5, 18, 12); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -24; key.shadow.camera.right = 24;
  key.shadow.camera.top = 20; key.shadow.camera.bottom = -18; key.shadow.normalBias = .04; key.shadow.bias = -.0004; scene.add(key);
  const rim = new T.DirectionalLight('#8ac5e7', 2.4); rim.position.set(4, 12, -10); scene.add(rim);
  const groups = new Map(), fullShells = [], cutShells = [], moving = [], pipes = [], water = [];
  const surfaces = new Set(); const geometries = new Set();
  const mat = (color, options = {}) => { const value = new T.MeshStandardMaterial({ color, roughness: .43, metalness: .68, ...options }); surfaces.add(value); return value; };
  const basic = (color, options = {}) => { const value = new T.MeshBasicMaterial({ color, ...options }); surfaces.add(value); return value; };
  const steel = mat('#819ca8'), darkSteel = mat('#2e4a5e'), edgeSteel = mat('#b4c8ce'), bronze = mat('#b68d5a'), black = mat('#183042');
  const fuelMaterial = mat('#9c7449', { emissive: '#ff762b', emissiveIntensity: 0, roughness: .55 });
  const heaterMaterial = mat('#b97d43', { emissive: '#ff7832', emissiveIntensity: 0 });
  const hotMaterial = mat('#c48952', { roughness: .37 }), coldMaterial = mat('#4286bd', { roughness: .37 });
  function mesh(geometry, material, parent, position = [0, 0, 0]) {
    geometries.add(geometry); const object = new T.Mesh(geometry, material); object.position.set(...position);
    object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  }
  function instances(geometry, material, parent, transforms) {
    geometries.add(geometry); const object = new T.InstancedMesh(geometry, material, transforms.length);
    const transform = new T.Object3D();
    transforms.forEach(({ position, rotation = [0, 0, 0] }, index) => {
      transform.position.set(...position); transform.rotation.set(...rotation); transform.updateMatrix(); object.setMatrixAt(index, transform.matrix);
    });
    object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  }
  const box = (parent, size, position, material = steel) => mesh(new T.BoxGeometry(...size), material, parent, position);
  const cylinder = (parent, radius, height, position, material = steel, segments = 32) => mesh(new T.CylinderGeometry(radius, radius, height, segments), material, parent, position);
  function tube(parent, points, radius, material, segments = 48) {
    const curve = new T.CatmullRomCurve3(points.map(point => new T.Vector3(...point)), false, 'centripetal', .3);
    const object = mesh(new T.TubeGeometry(curve, segments, radius, 10, false), material, parent);
    return { curve, object };
  }
  function ring(parent, radius, width, position, material = edgeSteel) {
    const object = mesh(new T.TorusGeometry(radius, width, 8, 48), material, parent, position); object.rotation.x = Math.PI / 2; return object;
  }
  function equipment(id) {
    const group = new T.Group(); group.userData.component = id; scene.add(group); groups.set(id, group); return group;
  }
  function bolts(parent, radius, y, center, count = 16) {
    const transforms = [];
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count;
      transforms.push({ position: [center[0] + Math.cos(angle) * radius, y, center[2] + Math.sin(angle) * radius] });
    }
    instances(new T.CylinderGeometry(.075, .075, .15, 6), darkSteel, parent, transforms);
  }
  function vessel(parent, x, z, radius, base, height) {
    const full = new T.Group(), cut = new T.Group(); parent.add(full, cut); fullShells.push(full); cutShells.push(cut);
    cylinder(full, radius, height, [x, base + height / 2, z]);
    mesh(new T.SphereGeometry(radius, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), steel, full, [x, base + height, z]).scale.y = .55;
    const lower = mesh(new T.SphereGeometry(radius, 40, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), steel, full, [x, base, z]); lower.scale.y = .55;
    // An open front sector exposes internals without deleting or changing model state.
    const section = mesh(new T.CylinderGeometry(radius, radius, height, 48, 1, true, Math.PI * .53, Math.PI * 1.47), steel, cut, [x, base + height / 2, z]);
    section.material = mat('#819ca8', { side: T.DoubleSide });
    for (const y of [base, base + .24, base + height - .1, base + height]) {
      ring(parent, radius + .025, .08, [x, y, z]);
    }
    bolts(parent, radius + .025, base + height + .07, [x, 0, z]);
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + i * Math.PI / 2;
      box(parent, [.25, base, .25], [x + radius * .8 * Math.cos(angle), base / 2, z + radius * .8 * Math.sin(angle)], darkSteel);
    }
    return { full, cut };
  }
  function processPipe(points, color, material, activity, radius = .17, count = 14) {
    const { curve } = tube(scene, points, radius, material);
    const group = new T.Group(); scene.add(group);
    const markerMaterial = basic(color, { transparent: true, opacity: .9, depthTest: false });
    const markerGeometry = new T.SphereGeometry(radius * .40, 7, 5); geometries.add(markerGeometry);
    const markers = new T.InstancedMesh(markerGeometry, markerMaterial, count);
    markers.renderOrder = 6; markers.frustumCulled = false; markers.instanceMatrix.setUsage(T.DynamicDrawUsage); group.add(markers);
    pipes.push({ curve, group, markers, phase: 0, activity, count, matrix: new T.Matrix4() });
  }
  function flange(point, axis = 'x', material = edgeSteel) {
    const disk = cylinder(scene, .31, .10, point, material); if (axis === 'x') disk.rotation.z = Math.PI / 2; else if (axis === 'z') disk.rotation.x = Math.PI / 2;
  }
  // Concrete island, structural steel and maintenance floor markings.
  box(scene, [native ? 18 : 31, .3, 17], [native ? -1.2 : 4.7, -.23, -.3], mat('#344454', { metalness: .03, roughness: .95 }));
  const grid = new T.GridHelper(42, 42, '#3a586b', '#263e50'); grid.position.y = -.065; scene.add(grid);
  geometries.add(grid.geometry); surfaces.add(grid.material);
  for (let x = -9; x <= (native ? 6 : 18); x += 3) box(scene, [.025, .01, 13.5], [x, -.06, -.3], mat('#70818c', { metalness: 0, roughness: 1 }));
  for (let z = -7; z <= 7; z += 2.5) box(scene, [native ? 16 : 29, .01, .025], [native ? -1.2 : 4.7, -.055, z], darkSteel);
  const reactor = equipment('reactor');
  box(reactor, [3.4, .45, 3.4], [-5, .23, 0], darkSteel);
  vessel(reactor, -5, 0, 1.23, .95, 4.2);
  cylinder(reactor, 1.04, .2, [-5, 1.45, 0], black);
  const fuelTransforms = [];
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (x * x + z * z > 11) continue;
    fuelTransforms.push({ position: [-5 + x * .23, 2.65, z * .23] });
  }
  instances(new T.CylinderGeometry(.075, .075, 2.25, 8), fuelMaterial, reactor, fuelTransforms);
  for (const y of [1.6, 2.25, 3.05, 3.75]) ring(reactor, .94, .045, [-5, y, 0], darkSteel);
  for (let i = 0; i < 9; i++) {
    const angle = i * Math.PI * 2 / 9;
    cylinder(reactor, .048, 1.3, [-5 + .65 * Math.cos(angle), 4.3, .65 * Math.sin(angle)], edgeSteel, 8);
  }
  cylinder(reactor, .48, .45, [-5, 5.6, 0], darkSteel); ring(reactor, .51, .055, [-5, 5.65, 0]);
  const sg = equipment('steamGenerator');
  box(sg, [3.5, .35, 3.5], [2, .17, 0], darkSteel); vessel(sg, 2, 0, 1.24, 1.2, 5.65);
  cylinder(sg, 1.02, .18, [2, 1.65, 0], black);
  for (let row = -2; row <= 2; row++) for (let column = -2; column <= 2; column++) {
    const width = .32 + (column + 2) * .12;
    tube(sg, [[2 - width, 1.8, row * .24], [2 - width, 4.9, row * .24], [2, 5.2 + .18 * column, row * .24], [2 + width, 4.9, row * .24], [2 + width, 1.8, row * .24]], .035, bronze, 30);
  }
  for (let i = 0; i < 5; i++) cylinder(sg, .14, .7, [1.3 + i * .34, 6.35, 0], edgeSteel, 12);
  const secondaryLevel = cylinder(sg, 1.07, 1, [2, 2.2, 0], mat('#3aafa8', { transparent: true, opacity: .22, metalness: .05, depthWrite: false }));
  secondaryLevel.visible = false; water.push({ object: secondaryLevel, key: 'steam', base: 1.7, height: 4.1 });
  const pzr = equipment('pressurizer');
  box(pzr, [1.9, .25, 1.9], [-1.5, .13, -4], darkSteel); vessel(pzr, -1.5, -4, .73, 4.2, 3.25);
  const pressurizerLevel = cylinder(pzr, .65, 1, [-1.5, 4.7, -4], mat('#53b5d3', { transparent: true, opacity: .40, metalness: .05, depthWrite: false }));
  pressurizerLevel.visible = false; water.push({ object: pressurizerLevel, key: 'pressurizer', base: 4.25, height: 3.1 });
  for (let i = -2; i <= 2; i++) tube(pzr, [[-1.5 + i * .17, 4.35, -4.2], [-1.5 + i * .17, 4.85, -4.2], [-1.5 + i * .17, 4.85, -3.8], [-1.5 + i * .17, 4.35, -3.8]], .035, heaterMaterial, 14);
  tube(pzr, [[-1.5, 7.8, -4], [-1.5, 7.1, -4], [-1.5, 7.0, -3.8]], .055, edgeSteel, 12);
  const sprayGroup = new T.Group(); pzr.add(sprayGroup);
  for (let i = 0; i < 12; i++) mesh(new T.SphereGeometry(.025, 6, 4), basic('#bceeff'), sprayGroup, [-1.5 + Math.sin(i * 2.4) * .3, 6.9 - i * .07, -4 + Math.cos(i * 2.4) * .3]);
  sprayGroup.visible = false;
  // Small actuator and instrument details identify the vessels as machinery.
  for (const [x, y, z] of [[-3.65, 3.5, 0], [3.35, 3.8, 0], [-.68, 5.5, -4]]) {
    const gauge = cylinder(scene, .16, .07, [x, y, z], mat('#d7e2dc', { metalness: .1 })); gauge.rotation.x = Math.PI / 2;
    box(scene, [.018, .13, .015], [x, y + .03, z + .05], black);
  }
  const pump = equipment('pump');
  box(pump, [2.1, .5, 1.8], [-.3, .25, 3.5], darkSteel);
  cylinder(pump, .65, .9, [-.3, 1.2, 3.5], coldMaterial);
  cylinder(pump, .54, 1.0, [-.3, 2.05, 3.5], darkSteel);
  for (let i = 0; i < 14; i++) {
    const angle = i * Math.PI * 2 / 14;
    box(pump, [.05, .85, .08], [-.3 + .56 * Math.cos(angle), 2.05, 3.5 + .56 * Math.sin(angle)], edgeSteel);
  }
  const pumpRotor = new T.Group(); pumpRotor.position.set(-.3, 2.65, 3.5); pump.add(pumpRotor);
  cylinder(pumpRotor, .12, .10, [0, 0, 0], bronze, 12);
  for (let i = 0; i < 6; i++) { const blade = box(pumpRotor, [.45, .07, .12], [.25 * Math.cos(i * Math.PI / 3), 0, .25 * Math.sin(i * Math.PI / 3)], bronze); blade.rotation.y = -i * Math.PI / 3; }
  ring(pump, .6, .035, [-.3, 2.65, 3.5]); moving.push({ object: pumpRotor, axis: 'y', key: 'pump', phase: 0 });
  processPipe([[-3.8, 3.5, 0], [-2.6, 3.5, 0], [-.4, 3.5, 0], [.8, 3.5, 0]], '#ffd19a', hotMaterial, 'primary');
  processPipe([[2, 1.9, 1.18], [2, 1.9, 3.5], [1, 1.45, 3.5], [-.3, 1.45, 3.5]], '#84cfff', coldMaterial, 'primary');
  processPipe([[-.3, 1.45, 3.5], [-2.5, 1.6, 3.5], [-5, 1.9, 3.5], [-5, 1.9, 1.2]], '#84cfff', coldMaterial, 'primary');
  tube(scene, [[-1.8, 3.5, 0], [-1.8, 3.5, -2.5], [-1.5, 3.8, -4], [-1.5, 4.2, -4]], .10, hotMaterial);
  for (const x of [-3.45, -2.1, .35]) flange([x, 3.5, 0]);
  for (const x of [-3.6, -1.8, .8]) flange([x, 1.6, 3.5]);
  if (native) {
    // Stub ends show the secondary boundary without inventing a steam circuit.
    tube(sg, [[2, 7, 0], [2, 7.55, 0], [4.5, 7.55, 0]], .14, edgeSteel, 20);
    flange([4.5, 7.55, 0]);
  } else {
    const turbine = equipment('turbine');
    box(turbine, [6.0, .6, 2.9], [9, .3, 1], darkSteel);
    const outer = new T.Group(); turbine.add(outer); fullShells.push(outer);
    const shell = cylinder(outer, 1.1, 5.3, [9, 2.15, 1], steel, 40); shell.rotation.z = Math.PI / 2;
    const open = new T.Group(); turbine.add(open); cutShells.push(open);
    const cut = mesh(new T.CylinderGeometry(1.1, 1.1, 5.3, 36, 1, true, Math.PI, Math.PI), mat('#819ca8', { side: T.DoubleSide }), open, [9, 2.15, 1]); cut.rotation.z = Math.PI / 2;
    for (const x of [6.5, 8, 10, 11.5]) { const rim = ring(turbine, 1.12, .055, [x, 2.15, 1]); rim.rotation.y = Math.PI / 2; rim.rotation.x = 0; }
    const rotor = new T.Group(); rotor.position.set(9, 2.15, 1); turbine.add(rotor);
    const shaft = cylinder(rotor, .14, 6.4, [0, 0, 0], bronze); shaft.rotation.z = Math.PI / 2;
    const bladeTransforms = [];
    for (let stage = 0; stage < 7; stage++) {
      const x = -2.1 + stage * .7, radius = .43 + stage * .055;
      const disk = cylinder(rotor, radius, .08, [x, 0, 0], bronze); disk.rotation.z = Math.PI / 2;
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        bladeTransforms.push({ position: [x, (radius + .09) * Math.cos(angle), (radius + .09) * Math.sin(angle)], rotation: [angle, .28, 0] });
      }
    }
    instances(new T.BoxGeometry(.13, .27, .07), edgeSteel, rotor, bladeTransforms);
    moving.push({ object: rotor, axis: 'x', key: 'turbine', phase: 0 });
    const generator = equipment('generator'); box(generator, [3.6, .6, 2.7], [14, .3, 1], darkSteel);
    const generatorOuter = new T.Group(); generator.add(generatorOuter); fullShells.push(generatorOuter);
    const genShell = cylinder(generatorOuter, 1.0, 3, [14, 2.15, 1], mat('#4d8190')); genShell.rotation.z = Math.PI / 2;
    const generatorCut = new T.Group(); generator.add(generatorCut); cutShells.push(generatorCut);
    const genOpen = mesh(new T.CylinderGeometry(1, 1, 3, 32, 1, true, Math.PI, Math.PI), mat('#4d8190', { side: T.DoubleSide }), generatorCut, [14, 2.15, 1]); genOpen.rotation.z = Math.PI / 2;
    const genRotor = new T.Group(); genRotor.position.set(14, 2.15, 1); generator.add(genRotor);
    const genShaft = cylinder(genRotor, .18, 4, [0, 0, 0], bronze); genShaft.rotation.z = Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      box(genRotor, [2.7, .18, .18], [0, .6 * Math.sin(angle), .6 * Math.cos(angle)], i % 2 ? bronze : edgeSteel);
    }
    moving.push({ object: genRotor, axis: 'x', key: 'generator', phase: 0 });
    const condenser = equipment('condenser'); box(condenser, [5.2, .3, 2.7], [9, .15, -5], darkSteel);
    const condShell = box(condenser, [4.8, 1.6, 2.5], [9, 1.25, -5], steel); fullShells.push(condShell);
    box(condenser, [4.8, .12, 2.5], [9, .5, -5], coldMaterial);
    for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
      const pipe = cylinder(condenser, .055, 4.6, [9, .75 + row * .35, -5.9 + column * .35], bronze, 8); pipe.rotation.z = Math.PI / 2;
    }
    for (const x of [6.6, 11.4]) box(condenser, [.15, 1.6, 2.5], [x, 1.25, -5], coldMaterial);
    processPipe([[2, 7, 0], [2, 7.5, 0], [5, 7.5, 0]], '#f5f4d9', steel, 'steamHeader', .14, 10);
    processPipe([[5, 7.5, 0], [6.5, 5.5, 1], [6.5, 2.8, 1]], '#f5f4d9', steel, 'steam', .14, 10);
    processPipe([[10.8, 2.1, .3], [10.8, 2.1, -2], [9, 2.1, -3.8]], '#e1e9df', steel, 'steam', .22, 12);
    processPipe([[6.6, .85, -5], [4, .85, -5], [3.7, 2, -3], [2.7, 2.5, -1]], '#85f2d4', mat('#3f9e92'), 'feed', .11, 16);
    processPipe([[11.4, 1.5, -5.4], [14, 1.5, -5.4], [16.5, .7, -5.4]], '#7be4f2', coldMaterial, 'cooling', .14, 12);
    processPipe([[16.5, .7, -6.6], [13, .7, -6.6], [11.4, 1, -5.9]], '#7be4f2', coldMaterial, 'cooling', .14, 12);
    processPipe([[15.5, 2.15, 1], [17, 2.15, 1], [17.5, 2.15, 2.5]], '#fee58b', black, 'electricity', .07, 10);
    // The bypass is a distinct path, so a closed turbine does not imply zero SG flow.
    processPipe([[5, 7.5, 0], [5.5, 6, -2.5], [7, 3.5, -4], [9, 2.1, -4]], '#f5f4d9', steel, 'bypass', .09, 10);
  }
  if (coupled) {
    const aux = equipment('auxiliary');
    const auxMaterial = mat('#3f9e92');
    box(aux, [7, .25, 3], [7.5, .13, 5.3], darkSteel);
    vessel(aux, 5.2, 5.3, 1.05, .4, 2.8);
    const tankWater = cylinder(aux, .96, 1, [5.2, .9, 5.3], mat('#53d9bd', { transparent: true, opacity: .4, metalness: .05, depthWrite: false }));
    tankWater.visible = false; water.push({ object: tankWater, key: 'auxTank', base: .45, height: 2.65 });
    for (const [x, train] of [[8, 'A'], [10, 'B']]) {
      cylinder(aux, .43, .65, [x, .8, 5.3], auxMaterial);
      cylinder(aux, .35, .8, [x, 1.5, 5.3], darkSteel);
      const rotor = new T.Group(); rotor.position.set(x, 1.95, 5.3); aux.add(rotor);
      for (let i = 0; i < 6; i++) { const blade = box(rotor, [.3, .06, .08], [.18 * Math.cos(i * Math.PI / 3), 0, .18 * Math.sin(i * Math.PI / 3)], bronze); blade.rotation.y = -i * Math.PI / 3; }
      ring(aux, .4, .03, [x, 1.95, 5.3]);
      moving.push({ object: rotor, axis: 'y', key: `aux${train}Pump`, phase: 0 });
      processPipe([[5.2, .75, 5.3], [5.2, .75, 6.5], [x, .75, 6.5], [x, .75, 5.3]], '#85f2d4', auxMaterial, `aux${train}Flow`, .075, 10);
      processPipe([[x, 1, 5.3], [x, 1, 4.3], [6.6, 1, 4.3]], '#85f2d4', auxMaterial, `aux${train}Flow`, .075, 10);
    }
    processPipe([[6.6, 1, 4.3], [3.4, 1, 4.3], [3.4, 3.2, 2], [2, 3.2, 1.1]], '#85f2d4', auxMaterial, 'auxiliary', .1, 14);
  }
  const selector = mesh(new T.TorusGeometry(1.8, .025, 5, 64), basic('#68e2db', { transparent: true, opacity: .75 }), scene);
  selector.rotation.x = Math.PI / 2; selector.position.set(-5, .055, 0); selector.castShadow = false;
  const raycaster = new T.Raycaster(); const pointer = new T.Vector2(); let down = null;
  on(canvas, 'pointerdown', event => { down = { x: event.clientX, y: event.clientY }; });
  on(canvas, 'pointerup', event => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) { down = null; return; }
    down = null; const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects([...groups.values()], true)) {
      let object = hit.object;
      let visible = true; for (let parent = object; parent; parent = parent.parent) visible &&= parent.visible;
      if (!visible) continue;
      while (object && !object.userData.component) object = object.parent;
      if (object) { select(object.userData.component); break; }
    }
  });
  on(canvas, 'pointercancel', () => { down = null; });
  on(canvas, 'keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') { preset('overview'); return; }
    const offset = camera.position.clone().sub(orbit.target); const spherical = new T.Spherical().setFromVector3(offset);
    if (event.key === 'ArrowLeft') spherical.theta -= .1;
    if (event.key === 'ArrowRight') spherical.theta += .1;
    if (event.key === 'ArrowUp') spherical.phi = Math.max(.03, spherical.phi - .08);
    if (event.key === 'ArrowDown') spherical.phi = Math.min(Math.PI * .49, spherical.phi + .08);
    if (event.key === '+' || event.key === '=') spherical.radius = Math.max(5, spherical.radius * .9);
    if (event.key === '-' || event.key === '_') spherical.radius = Math.min(55, spherical.radius * 1.1);
    camera.position.copy(orbit.target).add(new T.Vector3().setFromSpherical(spherical)); orbit.update(); requestRender();
  });
  on(canvas, 'webglcontextlost', event => { event.preventDefault(); throwContextLost(); });
  let contextLost = false;
  function throwContextLost() { contextLost = true; requestRender(); }
  function preset(name) {
    const configurations = {
      overview: { target: native ? [-1.8, 3, 0] : [4.5, 2.6, -.4], position: native ? [15, 15, 22] : [28, 21, 30] },
      primary: { target: [-1.7, 3.1, -.2], position: [12, 13, 19] },
      reactor: { target: [-5, 3, 0], position: [1.8, 8, 11] },
      turbine: { target: [10.4, 2.2, -.2], position: [21, 11, 17] },
      top: { target: native ? [-1.8, 0, 0] : [4, 0, -.5], position: native ? [-1.8, 28, .1] : [4, 38, -.4] },
    };
    const config = configurations[name] || configurations.overview;
    orbit.target.set(...config.target); camera.position.set(...config.position); orbit.update(); requestRender();
  }
  function resize() {
    const width = Math.max(1, viewport.clientWidth), height = Math.max(1, viewport.clientHeight);
    camera.aspect = width / height; camera.fov = width < 600 ? 50 : 40;
    camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
  }
  const projected = new T.Vector3();
  function positionLabels() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const placements = [];
    for (const id of ids) {
      const label = labelElements.get(id); projected.set(...COMPONENTS[id].label).project(camera);
      const visible = projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      label.style.display = visible ? '' : 'none'; if (!visible) continue;
      const half = (label.offsetWidth || 100) / 2;
      placements.push({ label, x: Math.max(half + 5, Math.min(width - half - 5, (projected.x * .5 + .5) * width)),
        y: Math.max(74, Math.min(height - 30, (-projected.y * .5 + .5) * height)), width: half * 2, height: label.offsetHeight || 38 });
    }
    placements.sort((a, b) => a.y - b.y);
    for (let i = 0; i < placements.length; i++) {
      const current = placements[i];
      for (let j = 0; j < i; j++) {
        const earlier = placements[j];
        if (Math.abs(current.x - earlier.x) < (current.width + earlier.width) / 2 + 4 && current.y - current.height < earlier.y + 4) current.y = earlier.y + current.height + 5;
      }
      current.label.style.left = `${current.x}px`; current.label.style.top = `${Math.min(height - 24, current.y)}px`;
    }
  }
  let showFlow = true;
  preset('overview'); resize();
  return {
    resize, preset,
    focus(id) { const position = COMPONENTS[id].position; orbit.target.set(...position); camera.position.set(position[0] + 7.5, position[1] + 5.5, position[2] + 10); orbit.update(); },
    select(id) { const p = COMPONENTS[id].position; selector.position.set(p[0], .055, p[2]); selector.scale.setScalar(['turbine', 'condenser', 'generator'].includes(id) ? 1.35 : id === 'pump' ? .6 : 1); },
    cutaway(value) { for (const shell of fullShells) shell.visible = !value; for (const shell of cutShells) shell.visible = value; },
    flow(value) { showFlow = value; },
    render(state, elapsed) {
      if (contextLost) throw new Error('WebGL context was lost');
      const a = state.activity;
      fuelMaterial.emissiveIntensity = state.available ? a.heat * 1.35 : 0;
      heaterMaterial.emissiveIntensity = state.available ? a.heater * 2 : 0;
      for (const rotor of moving) { rotor.phase = advanceVisualPhase(rotor.phase, a[rotor.key], elapsed); rotor.object.rotation[rotor.axis] = rotor.phase * Math.PI * 2; }
      for (const flow of pipes) {
        const rate = a[flow.activity]; flow.group.visible = showFlow && state.available && Math.abs(rate) > .0001;
        flow.phase = advanceVisualPhase(flow.phase, rate * .16, elapsed);
        for (let i = 0; i < flow.count; i++) {
          const point = flow.curve.getPointAt((i / flow.count + flow.phase) % 1);
          flow.matrix.makeTranslation(point.x, point.y, point.z); flow.markers.setMatrixAt(i, flow.matrix);
        }
        flow.markers.instanceMatrix.needsUpdate = true;
      }
      for (const level of water) {
        const value = state.levels[level.key]; level.object.visible = value !== null && value > 0;
        if (value !== null) { level.object.scale.y = Math.max(.001, value * level.height); level.object.position.y = level.base + value * level.height / 2; }
      }
      sprayGroup.visible = showFlow && state.available && a.spray > 0;
      orbit.update(); renderer.render(scene, camera); positionLabels();
    },
    dispose() {
      orbit.removeEventListener('change', requestRender); orbit.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of surfaces) { if (Array.isArray(material)) material.forEach(item => item.dispose()); else material.dispose(); }
      renderer.dispose(); canvas.remove();
    },
  };
}
