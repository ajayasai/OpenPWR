// SPDX-License-Identifier: Apache-2.0
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PWRPlant } from '../src/engine.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scenario = option('scenario', 'load-step');
const duration = Number(option('duration', '600'));
const dt = Number(option('dt', '0.05'));
const output = option('output', 'artifacts/scenario.csv');
const scenarios = ['nominal', 'load-step', 'scram', 'pump-trip', 'feedwater-loss', 'turbine-trip', 'heat-sink-loss'];
if (args.includes('--help')) {
  console.log('OpenPWR deterministic headless runner\n\nnode scripts/simulate.mjs --scenario=load-step --duration=600 --dt=0.05 --output=artifacts/scenario.csv\n\nScenarios: ' + scenarios.join(', ') + '\nEvents occur at t=60 s; output samples at 1 s plus final state. No plant validation is implied.');
  process.exit(0);
}
if (!scenarios.includes(scenario)) throw new Error(`Unknown scenario. Use: ${scenarios.join(', ')}`);
if (!Number.isFinite(duration) || duration < 1 || duration > 86400) throw new Error('Duration must be 1..86400 s');
if (!Number.isFinite(dt) || dt < 0.001 || dt > 0.1) throw new Error('dt must be 0.001..0.1 s');
const plant = new PWRPlant();
const fields = ['time', 'electricPower', 'thermalPower', 'neutronPower', 'decayPower', 'fuelTemp', 'hotLegTemp', 'coldLegTemp', 'primaryPressure', 'steamPressure', 'steamLevel', 'steamFlow', 'feedFlow', 'condenserPressure', 'reactivity', 'xenon', 'energyResidual', 'tripped'];
const rows = [fields.join(',')];
let triggered = false, nextSample = 0, final, lastRecordedTime = -1;
while (plant.snapshot().time < duration - 1e-9) {
  const s = plant.snapshot();
  if (!triggered && s.time >= 60 - 1e-9) {
    triggered = true;
    if (scenario === 'load-step') plant.setControl('demand', 0.75);
    if (scenario === 'scram') plant.scram('Headless scenario');
    for (const [name, fault] of Object.entries({ 'pump-trip': 'primaryPumpTrip', 'feedwater-loss': 'feedwaterTrip', 'turbine-trip': 'turbineTrip', 'heat-sink-loss': 'lossOfHeatSink' })) if (scenario === name) plant.setFault(fault, true);
  }
  if (s.time >= nextSample - 1e-9) { rows.push(fields.map(f => s[f]).join(',')); lastRecordedTime = s.time; nextSample += 1; }
  if (s.domainExceeded) { final = s; break; }
  const untilEvent = !triggered && s.time < 60 ? 60 - s.time : Infinity;
  plant.step(Math.min(dt, duration - s.time, untilEvent, nextSample - s.time));
}
final ??= plant.snapshot();
if (Math.abs(final.time - lastRecordedTime) > 1e-9) rows.push(fields.map(f => final[f]).join(','));
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, rows.join('\n') + '\n');
await writeFile(target + '.json', JSON.stringify({ schema: 'openpwr-run/v1', scenario, requestedDuration: duration, dt, units: { time: 's', electricPower: 'MW net', thermalPower: 'MW', temperatures: 'degC', primaryPressure: 'MPa', steamPressure: 'MPa', condenserPressure: 'kPa', reactivity: 'pcm', energyResidual: 'MW' }, final }, null, 2));
console.log(JSON.stringify({ scenario, simulationTime: final.time, electricPowerMW: final.electricPower, tripped: final.tripped, domainExceeded: final.domainExceeded ?? false, csv: target }, null, 2));
if (final.domainExceeded) process.exitCode = 2;
