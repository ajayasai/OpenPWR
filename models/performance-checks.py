# SPDX-License-Identifier: Apache-2.0
"""Measure fixed native FMI workloads, retaining observations and conservation errors.

This is a reproducible throughput experiment, not a real-time guarantee. Run the
same command for two FMUs and compare their median integration wall times. The
timed loop includes doStep, all public Real outputs, and the validity observation;
FMU extraction, initialization, and teardown are measured separately.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import platform
from pathlib import Path
import statistics
import tempfile
import time

CASES = (
    ('equilibrium', 10, {}),
    ('pump', 7, {'pumpCommand': .9}),
    ('heater', 10, {'heaterPowerMW': 1}),
    ('spray', 10, {'sprayFlowKgS': 10}),
    ('inventory', 10, {'heaterPowerMW': .5, 'chargingFlowKgS': 2, 'letdownFlowKgS': .5}),
)


def measure(fmu_path, repeats, step):
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave
    description = read_model_description(str(fmu_path), validate=True)
    refs = {v.name: v.valueReference for v in description.modelVariables}
    outputs = [v.name for v in description.modelVariables if v.causality == 'output' and v.type == 'Real']
    defaults = {v.name: float(v.start) for v in description.modelVariables if v.causality == 'input'}
    runs = []
    with tempfile.TemporaryDirectory(prefix='openpwr-throughput-') as work:
        extract(str(fmu_path), unzipdir=work)
        for repeat in range(repeats):
            for case, seconds, controls in CASES:
                start = time.perf_counter()
                unit = FMU2Slave(guid=description.guid, unzipDirectory=work,
                                modelIdentifier=description.coSimulation.modelIdentifier,
                                instanceName=f'performance_{repeat}_{case}')
                unit.instantiate()
                try:
                    unit.setupExperiment(startTime=0)
                    unit.enterInitializationMode()
                    values = {**defaults, **controls}
                    unit.setReal([refs[n] for n in values], list(values.values()))
                    unit.exitInitializationMode()
                    def read():
                        data = dict(zip(outputs, unit.getReal([refs[n] for n in outputs])))
                        data['valid'] = bool(unit.getBoolean([refs['valid']])[0])
                        if not data['valid'] or any(not math.isfinite(data[n]) for n in outputs):
                            raise RuntimeError(f'Invalid observation in {case}')
                        return data
                    initial = read()
                    initialize_wall = time.perf_counter() - start
                    snapshots = [{'time': 0, **initial}]
                    previous = initial
                    energy_integral = mass_integral = 0.0
                    start = time.perf_counter()
                    cpu_start = time.process_time()
                    for index in range(round(seconds / step)):
                        unit.doStep(currentCommunicationPoint=index * step, communicationStepSize=step)
                        current = read()
                        energy_integral += step * (previous['boundaryPowerMW'] + current['boundaryPowerMW']) / 2
                        mass_integral += step * (previous['boundaryMassFlowKgS'] + current['boundaryMassFlowKgS']) / 2
                        previous = current
                        if (index + 1) % round(1 / step) == 0:
                            snapshots.append({'time': (index + 1) * step, **current})
                    wall = time.perf_counter() - start
                    cpu = time.process_time() - cpu_start
                    mass_error = current['totalMassKg'] - initial['totalMassKg'] - mass_integral
                    energy_error = current['thermalEnergyMJ'] - initial['thermalEnergyMJ'] - energy_integral
                    runs.append({'case': case, 'repeat': repeat + 1, 'controls': controls,
                                 'simulatedSeconds': seconds, 'integrationWallSeconds': wall,
                                 'integrationCpuSeconds': cpu, 'initializationWallSeconds': initialize_wall,
                                 'simulatedSecondsPerWallSecond': seconds / wall,
                                 'massBalanceErrorKg': mass_error, 'energyBalanceErrorMJ': energy_error,
                                 'observations': snapshots})
                    print(f'{case} #{repeat + 1}: {seconds:g} sim s / {wall:.5f} wall s = {seconds / wall:.3f}x; '
                          f'mass error {mass_error:.6g} kg, energy error {energy_error:.6g} MJ', flush=True)
                    unit.terminate()
                finally:
                    unit.freeInstance()
    summaries = []
    for case, seconds, _ in CASES:
        matching = [r for r in runs if r['case'] == case]
        median = statistics.median(r['integrationWallSeconds'] for r in matching)
        summaries.append({'case': case, 'simulatedSeconds': seconds, 'medianIntegrationWallSeconds': median,
                          'simulatedSecondsPerWallSecond': seconds / median,
                          'maxMassBalanceErrorKg': max(abs(r['massBalanceErrorKg']) for r in matching),
                          'maxEnergyBalanceErrorMJ': max(abs(r['energyBalanceErrorMJ']) for r in matching)})
    return {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'fmuSha256': hashlib.sha256(fmu_path.read_bytes()).hexdigest(),
            'fmuPath': str(fmu_path), 'compiler': description.generationTool, 'host': platform.platform(),
            'processor': platform.processor(), 'python': platform.python_version(),
            'stepSeconds': step, 'repeats': repeats, 'summary': summaries, 'runs': runs,
            'scope': 'Fixed native FMI workloads, public output reads and independent trapezoidal boundary integrals. '
                     'Timing excludes extraction/initialization. Throughput depends on host and workload; '
                     'these are numerical consistency observations, not plant-transient validation.'}


def compare(baseline_path, candidate_path):
    baseline = json.loads(baseline_path.read_text())
    candidate = json.loads(candidate_path.read_text())
    for key in ('stepSeconds', 'repeats', 'host', 'compiler'):
        if baseline[key] != candidate[key]:
            raise ValueError(f'Comparison requires identical {key}')
    if len(baseline['summary']) != len(candidate['summary']) or len(baseline['runs']) != len(candidate['runs']):
        raise ValueError('The number of cases or repetitions differs')

    def identity(report_path, report):
        manifest = json.loads((report_path.parent / 'manifest.json').read_text())
        if manifest['fmuSha256'] != report['fmuSha256']:
            raise ValueError(f'Manifest no longer identifies the measured FMU: {report_path}')
        return {name: manifest.get(name) for name in
                ('version', 'gitRevision', 'dirty', 'sourceSha256', 'fmuSha256', 'compiler', 'modelicaLibrary')}

    baseline_identity = identity(baseline_path, baseline)
    candidate_identity = identity(candidate_path, candidate)
    # Regression tolerances reflect the former model's numerical error; they
    # are not uncertainty estimates or measured plant acceptance criteria.
    tolerances = {'hotLegTemperatureC': .01, 'coldLegTemperatureC': .01,
                  'fuelTemperatureC': .01, 'primaryPressureMPa': .001,
                  'pressurizerLevelPercent': .01, 'primaryFlowKgS': .1,
                  'totalMassKg': .1, 'thermalEnergyMJ': .2}
    rows = []
    for before, after in zip(baseline['summary'], candidate['summary']):
        if before['case'] != after['case'] or before['simulatedSeconds'] != after['simulatedSeconds']:
            raise ValueError('The benchmark workloads differ')
        old_runs = [r for r in baseline['runs'] if r['case'] == before['case']]
        new_runs = [r for r in candidate['runs'] if r['case'] == after['case']]
        differences = {name: 0.0 for name in tolerances}
        for old, new in zip(old_runs, new_runs):
            if old['controls'] != new['controls'] or len(old['observations']) != len(new['observations']):
                raise ValueError('The controls or observation grids differ')
            for a, b in zip(old['observations'], new['observations']):
                if a['time'] != b['time']:
                    raise ValueError('The observation times differ')
                for name in differences:
                    differences[name] = max(differences[name], abs(a[name] - b[name]))
        # Allow only a roundoff-sized absolute slack at the zero-error equilibrium.
        conservation_pass = (after['maxMassBalanceErrorKg'] <= before['maxMassBalanceErrorKg'] + 1e-6
                             and after['maxEnergyBalanceErrorMJ'] <= before['maxEnergyBalanceErrorMJ'] + 1e-6)
        trace_pass = all(differences[name] <= tolerance for name, tolerance in tolerances.items())
        rows.append({'case': before['case'], 'simulatedSeconds': before['simulatedSeconds'],
                     'baselineMedianWallSeconds': before['medianIntegrationWallSeconds'],
                     'candidateMedianWallSeconds': after['medianIntegrationWallSeconds'],
                     'measuredSpeedRatio': before['medianIntegrationWallSeconds'] / after['medianIntegrationWallSeconds'],
                     'candidateSimulatedSecondsPerWallSecond': after['simulatedSecondsPerWallSecond'],
                     'baselineMassErrorKg': before['maxMassBalanceErrorKg'], 'candidateMassErrorKg': after['maxMassBalanceErrorKg'],
                     'baselineEnergyErrorMJ': before['maxEnergyBalanceErrorMJ'], 'candidateEnergyErrorMJ': after['maxEnergyBalanceErrorMJ'],
                     'maximumTrajectoryDifference': differences, 'trajectoryTolerances': tolerances,
                     'conservationNonRegression': conservation_pass, 'trajectoryRegressionPass': trace_pass,
                     'pass': conservation_pass and trace_pass})
    ratio = sum(r['baselineMedianWallSeconds'] for r in rows) / sum(r['candidateMedianWallSeconds'] for r in rows)
    report = {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
              'baselineFmuSha256': baseline['fmuSha256'], 'candidateFmuSha256': candidate['fmuSha256'],
              'baselineIdentity': baseline_identity, 'candidateIdentity': candidate_identity,
              'host': candidate['host'], 'compiler': candidate['compiler'],
              'stepSeconds': candidate['stepSeconds'], 'repeats': candidate['repeats'],
              'aggregateMedianWorkloadSpeedRatio': ratio, 'cases': rows,
              'passed': sum(r['pass'] for r in rows), 'total': len(rows),
              'scope': 'Same native workloads, communication step and output reads; extraction/initialization excluded. '
                       'Ratios near one can fall within host timing variation. Conservation and trajectory comparisons '
                       'are numerical regression checks, not plant validation or a real-time guarantee.'}
    for row in rows:
        print(f"{row['case']}: {row['measuredSpeedRatio']:.3f}x measured speed ratio; regression {'PASS' if row['pass'] else 'FAIL'}")
    print(f'Aggregate median workload ratio: {ratio:.3f}x')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fmu', type=Path)
    mode.add_argument('--compare', type=Path, nargs=2, metavar=('BASELINE_REPORT', 'CANDIDATE_REPORT'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--step', type=float, choices=(.025, .05), default=.05)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('--repeats must be positive')
    report = compare(*args.compare) if args.compare else measure(args.fmu.resolve(), args.repeats, args.step)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    if args.compare and report['passed'] != report['total']:
        raise SystemExit(1)
