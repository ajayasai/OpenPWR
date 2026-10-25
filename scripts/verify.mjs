// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PWRPlant } from '../src/engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const gitValue = args => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); }
  catch { return null; }
};
const checks = [];
const add = (name, pass, evidence) => checks.push({ name, pass: Boolean(pass), evidence });
const run = (plant, duration, dt = 0.05) => {
  const end = plant.snapshot().time + duration;
  let maxResidual = 0;
  while (plant.snapshot().time < end - 1e-8) {
    const before = plant.snapshot();
    if (before.domainExceeded) break;
    plant.step(Math.min(dt, end - before.time));
    maxResidual = Math.max(maxResidual, Math.abs(plant.snapshot().energyResidual));
  }
  return { ...plant.snapshot(), maxResidual };
};
const f = (n, digits = 3) => Number(n).toFixed(digits);

const start = performance.now();
const nominal = new PWRPlant();
const steady = run(nominal, 600);
add('Nominal equilibrium · 10 minutes', !steady.tripped && !steady.domainExceeded && Math.abs(steady.electricPower - 1000) < 1 && Math.abs(steady.thermalPower - 3000) < 3,
  `Net ${f(steady.electricPower)} MWe; thermal ${f(steady.thermalPower)} MW; reactor trip ${steady.tripped}; domain exit ${Boolean(steady.domainExceeded)}. Acceptance: net within 1 MW and thermal within 3 MW of nominal.`);
add('Thermal storage energy accounting', steady.maxResidual < 1e-5,
  `Maximum absolute discrete energy-balance residual ${steady.maxResidual.toExponential(3)} MW. Acceptance < 1e-5 MW; applies only to the documented fuel/primary/SG thermal boundary.`);

const follow = new PWRPlant();
follow.setControl('demand', 0.75);
const load = run(follow, 900);
add('Load following · 100% → 75%', !load.tripped && !load.domainExceeded && Math.abs(load.electricPower - 750) < 2,
  `After ${f(load.time, 0)} s: ${f(load.electricPower)} MWe, ${f(load.thermalPower)} MWth, trip ${load.tripped}. Acceptance: 748–752 MWe without reactor trip or domain exit.`);

const scrammed = new PWRPlant();
scrammed.scram('Verification scenario');
const shutdown = run(scrammed, 30);
add('Reactor trip with residual heat', shutdown.tripped && shutdown.neutronPower < 0.05 && shutdown.decayPower > 0 && !shutdown.domainExceeded,
  `At 30 s: fission ${f(shutdown.neutronPower * 100)}%, decay heat ${f(shutdown.decayPower)} MW. Acceptance: fission < 5%, decay heat > 0, trip latched, state within model domain.`);

for (const [fault, name, duration] of [['primaryPumpTrip', 'Primary pump trip', 30], ['turbineTrip', 'Turbine trip', 30], ['feedwaterTrip', 'Feedwater loss', 180], ['lossOfHeatSink', 'Heat sink loss', 180]]) {
  const plant = new PWRPlant();
  plant.setFault(fault, true);
  const s = run(plant, duration);
  add(name + ' · protection response', s.tripped && Number.isFinite(s.thermalPower),
    `At ${f(s.time, 1)} s: trip ${s.tripped}, reason “${s.tripReason}”, net ${f(s.electricPower, 1)} MWe, domain exit ${Boolean(s.domainExceeded)}${s.domainReason ? ': ' + s.domainReason : ''}. Acceptance: protective reactor trip with finite diagnostics; any domain exit is reported, not extrapolated.`);
}

const a = new PWRPlant();
a.setControl('demand', 0.8);
run(a, 60);
const b = new PWRPlant();
b.importState(JSON.parse(JSON.stringify(a.exportState())));
const sa = run(a, 60), sb = run(b, 60);
const replayError = Math.max(...['thermalPower', 'electricPower', 'fuelTemp', 'steamPressure', 'neutronPower'].map(key => Math.abs(sa[key] - sb[key])));
add('Saved-state continuation', replayError < 1e-10,
  `Maximum selected-state difference after JSON round trip and 60 s continuation: ${replayError.toExponential(3)}. Acceptance < 1e-10 in each listed variable's native units.`);

const fine = new PWRPlant(), coarse = new PWRPlant();
fine.setControl('demand', 0.8); coarse.setControl('demand', 0.8);
const sf = run(fine, 120, 0.025), sc = run(coarse, 120, 0.05);
const refinement = Math.abs(sf.electricPower - sc.electricPower);
add('External time-step refinement', refinement < 5 && !sf.domainExceeded && !sc.domainExceeded,
  `At 120 s after 80% demand: net power difference ${f(refinement, 6)} MW for 0.025/0.05 s stepping. Acceptance < 5 MW. See tests for independent pure-kinetics solver checks.`);

const report = {
  schema: 'openpwr-verification/v1', version: pkg.version, generatedAt: new Date().toISOString(), runtime: `Node ${process.version} / ${process.platform} / ${process.arch}`,
  gitRevision: gitValue(['rev-parse', 'HEAD']), workingTreeDirty: Boolean(gitValue(['status', '--porcelain'])),
  scope: 'Numerical verification and generic response checks, not validation against a real plant. Tests and assumptions are inspectable in the repository.',
  wallTimeSeconds: (performance.now() - start) / 1000,
  passed: checks.filter(c => c.pass).length, checks,
};
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(resolve(root, 'artifacts/verification.json'), JSON.stringify(report, null, 2) + '\n');
for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}\n  ${check.evidence}`);
console.log(`${report.passed}/${checks.length} checks passed in ${f(report.wallTimeSeconds, 2)} s.`);
if (report.passed !== checks.length) process.exitCode = 1;
