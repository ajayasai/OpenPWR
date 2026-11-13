"""Prospective numerical checks for continuous native cold-to-power operation.

The oracle for source-driven kinetics is an independently assembled augmented
matrix exponential. Conservation uses physical inventories and independently
reconstructed external fluxes. None of these tests is measured plant validation.
"""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.verify import git_value, read_verified_manifest
from backend.verify_plant import matrix_exponential_action
from backend.verify_cold import saturation_pressure_pa, boundary_flux as cold_boundary_flux
from validation.native_fmi import run_case, sha

PROTOCOL_PATH = ROOT / 'validation/continuous/protocol.json'
REFERENCE_PATH = ROOT / 'validation/continuous/kinetics-reference.json'
INITIAL_PROTOCOL_PATH = ROOT / 'validation/continuous/protocol-initial.json'
INITIAL_PROTOCOL_SHA256 = '6a7fcc9d7c8d695a7732325c17a23360cc58da8e0b43a6a07a24ab18754add27'
PROTOCOL_SHA256 = '37c61f114fe566b7ac101f429e6d548b973b4fcec992bf24e55002ca8ffa0c5c'
REFERENCE_SHA256 = 'a5515f11d630519d1ee88f894f3309eda61cd8b32fc73dddbfecf15113ba6f53'
DEFAULT_BETA = (.000215, .001424, .001274, .002568, .000748, .000273)
DEFAULT_LAMBDA = (.0124, .0305, .111, .301, 1.14, 3.01)
KINETIC_OUTPUTS = ('neutronPowerFraction', *(f'precursor{i}' for i in range(1, 7)))
# Prospective component check added with the fast stop-valve correction, before
# scoring that corrected candidate. Existing whole-trajectory limits are fixed.
STOP_VALVE_ABSOLUTE_TOLERANCE = 2e-6


def load_reference_inputs():
    """Reject silent edits to the prospective protocol or published answers."""
    for path, expected in ((PROTOCOL_PATH, PROTOCOL_SHA256),
                           (INITIAL_PROTOCOL_PATH, INITIAL_PROTOCOL_SHA256),
                           (REFERENCE_PATH, REFERENCE_SHA256)):
        if sha(path) != expected:
            raise RuntimeError(f'{path.name} changed; an explicit reviewed protocol amendment is required.')
    return (json.loads(PROTOCOL_PATH.read_text(encoding='utf-8')),
            json.loads(REFERENCE_PATH.read_text(encoding='utf-8')))


def kinetics_reference(seconds, initial_neutron, reactivity_pcm, source_per_second,
                       beta=DEFAULT_BETA, decay=DEFAULT_LAMBDA, generation=1e-4,
                       initial_precursors=None):
    """Solve seven affine kinetic equations by an independent 8x8 exponential.

    Normalized precursors z_i obey dz_i/dt=lambda_i*(n-z_i). The eighth
    coordinate is one, so the external source occupies matrix[0][7]. This
    includes the source through the exponential, not an Euler add-on.
    """
    if (len(beta) != 6 or len(decay) != 6 or generation <= 0 or seconds < 0
            or not all(math.isfinite(x) for x in
                       (seconds, initial_neutron, reactivity_pcm, source_per_second,
                        generation, *beta, *decay))):
        raise ValueError('Invalid independent kinetics problem.')
    precursors = list(initial_precursors) if initial_precursors is not None else [initial_neutron] * 6
    if len(precursors) != 6 or not all(math.isfinite(x) for x in precursors):
        raise ValueError('Six finite initial precursor values are required.')
    matrix = [[0.0] * 8 for _ in range(8)]
    matrix[0][0] = (reactivity_pcm * 1e-5 - sum(beta)) / generation
    for index, (fraction, rate) in enumerate(zip(beta, decay), 1):
        matrix[0][index] = fraction / generation
        matrix[index][0], matrix[index][index] = rate, -rate
    matrix[0][7] = source_per_second
    return matrix_exponential_action(matrix, seconds, [initial_neutron, *precursors, 1.0])[:7]


def maximum_relative_kinetics_error(points, reactivity_pcm, source_per_second,
                                    initial_neutron, **parameters):
    """Compare all seven native kinetic states at every retained sample."""
    comparisons = []
    for point in points:
        reference = kinetics_reference(point['time'], initial_neutron,
                                       reactivity_pcm, source_per_second, **parameters)
        actual = [point[name] for name in KINETIC_OUTPUTS]
        relative = [abs(a - e) / max(abs(e), abs(initial_neutron) * 1e-12)
                    for a, e in zip(actual, reference)]
        comparisons.append({'time': point['time'], 'reference': dict(zip(KINETIC_OUTPUTS, reference)),
                            'actual': dict(zip(KINETIC_OUTPUTS, actual)),
                            'maximumRelativeError': max(relative)})
    return max(item['maximumRelativeError'] for item in comparisons), comparisons


def rotor_energy_mj(rpm, inertia_kg_m2):
    return .5 * inertia_kg_m2 * (rpm * math.pi / 30) ** 2 / 1e6


def physical_gas_eos_residual(point, prefix, volume_m3):
    temperature = point[prefix + 'TemperatureC'] + 273.15
    pressure = point['primaryPressureMPa' if prefix == 'pressurizer' else 'secondaryPressureMPa'] * 1e6
    vapor_volume = volume_m3 * (1 - point[prefix + 'LevelPercent'] / 100)
    return pressure - saturation_pressure_pa(temperature) - point[prefix + 'GasMassKg'] * 296.8 * temperature / vapor_volume


def retained_pairs(coarse, fine):
    """Match exact retained times; interpolation cannot hide event differences."""
    fine_by_time = {round(point['time'], 10): point for point in fine}
    if len(fine_by_time) != len(fine):
        raise ValueError('Reference trace repeats a retained time.')
    pairs = []
    for point in coarse:
        key = round(point['time'], 10)
        if key not in fine_by_time:
            raise ValueError('Refinement traces do not share the same retained time grid.')
        pairs.append((point, fine_by_time[key]))
    return pairs


def startup_inputs(t):
    """Independent reconstruction of the declared generic control experiment."""
    from backend.profiles import CONTINUOUS_DEFAULT_CONTROLS
    u = dict(CONTINUOUS_DEFAULT_CONTROLS)
    u.update(pumpCommand=1, reactorDemandPercent=.5, automaticReactorEnable=1,
             shutdownCoolingFraction=0, pressureControlEnable=1, pressureTargetMPa=15.5)
    u['ventFraction'] = float(3600 <= t < 7200)
    if t >= 18000:
        u.update(reactorDemandPercent=5, sourceEnable=0, turbineEnable=1,
                 speedDemandRpm=3000, excitationCommandPu=1, automaticSyncEnable=1)
    if t >= 20000:
        u['gridBreakerCommand'] = 1
    if t >= 22000:
        u['reactorDemandPercent'] = 100
    if t >= 24000:
        u['loadDemandMW'] = 1000
    return u


def trip_inputs(t):
    u = startup_inputs(t)
    if t >= 27000:
        u['tripCommand'] = 1
    return u


def constant_inputs(**changes):
    from backend.profiles import CONTINUOUS_DEFAULT_CONTROLS
    u = dict(CONTINUOUS_DEFAULT_CONTROLS)
    u.update(shutdownCoolingFraction=0, inventoryControlEnable=0)
    u.update(changes)
    return lambda _t: dict(u)


def declared_schedule(trip=False):
    from backend.experiments import CONTINUOUS_STARTUP_COMMANDS
    from backend.profiles import CONTINUOUS_DEFAULT_CONTROLS
    schedule = json.loads(json.dumps(CONTINUOUS_STARTUP_COMMANDS))
    if trip:
        schedule.append({'time': 27000.0, 'controls': {'tripCommand': 1.0}})
    held = dict(CONTINUOUS_DEFAULT_CONTROLS)
    forcing = trip_inputs if trip else startup_inputs
    for event in schedule:
        if held != forcing(max(0, event['time'] - .25)) and event['time'] != 0:
            raise ValueError('Independent verification forcing differs before declared control event.')
        held.update(event['controls'])
        if held != forcing(event['time']):
            raise ValueError('Independent verification forcing differs from declared control schedule.')
    return schedule


def execute(fmu_path, duration, step=.5, forcing=startup_inputs, sample_interval=30,
            parameters=None, event_times=(), integrate_boundary=True):
    from backend.profiles import PROFILES
    profile = PROFILES['continuous']
    integrals = (('externalEnergyMJ', lambda u, p: boundary_flux(u, p)[0]),
                 ('externalMassKg', lambda u, p: boundary_flux(u, p)[1])) if integrate_boundary else ()
    return run_case(Path(fmu_path), 'ContinuousPlant', tuple(profile['real_outputs']),
                    tuple(profile['limits']), forcing, duration, step,
                    parameters=parameters, sample_interval=sample_interval,
                    event_times=event_times, boundary_integrals=integrals,
                    solver_tolerance=1e-9)


def boundary_flux(controls, point):
    """Reconstruct the thermal/shaft control-volume boundary, then quadrature.

    Reuses the independently implemented cold-vessel flux algebra, with native
    neutron and decay populations as the thermal source. Condenser displacement
    work and fluid enthalpies are shared thermodynamic primitives; the boundary
    totals, generator work, controlled heat rejection and pump work are rebuilt.
    No native aggregate boundary or residual output is used in this oracle.
    Decay inventory is outside this *thermal* control volume, as in the model.
    """
    thermal_controls = {**controls, 'startupHeatMW': .934*3000*point['neutronPowerFraction']+point['decayHeatMW']}
    thermal_energy, mass = cold_boundary_flux(thermal_controls, point)
    pump_work = point['feedwaterFlowKgS']*(point['feedwaterEnthalpyJkg']-point['condenserLiquidEnthalpyJkg'])/1e6
    rejected = controls['coolingFraction']*200*(point['condenserTemperatureC']-15)
    speed = point['turbineRpm']/3000
    friction = 2*speed**3
    connected = (point['gridConnected']>.5 and controls['gridBreakerCommand']>.5 and
                 controls['tripCommand']<.5 and controls['turbineTripCommand']<.5 and point['reactorTripped']<.5)
    shaft_electrical = ((3000*point['generatorVoltagePu']*math.sin(math.radians(point['phaseDifferenceDeg']))
                        +120000*(speed-1))*speed) if connected else 0
    return (thermal_energy+pump_work-rejected-point['condenserDisplacementPowerMW']-friction-shaft_electrical,
            mass)


def verify(fmu_path, output_path):
    protocol, published = load_reference_inputs()
    manifest = read_verified_manifest(fmu_path, expected_model='ContinuousPlant',
                                      manifest_name='continuous-manifest.json')
    bindings = {
        'coldSourceSha256': 'models/ColdStartPlant.mo',
        'pressureSourceSha256': 'models/FinitePhasePressurizer.mo',
        'continuousSourceSha256': 'models/ContinuousPlant.mo',
        'verificationScriptSha256': 'backend/verify_continuous.py',
        'commonVerifierSha256': 'backend/verify.py',
        'kineticsOracleSha256': 'backend/verify_plant.py',
        'coldVerifierSha256': 'backend/verify_cold.py',
        'sharedRunnerSha256': 'validation/native_fmi.py',
        'hostScriptSha256': 'backend/fmi_host.py',
        'profileScriptSha256': 'backend/profiles.py',
        'protocolSha256': 'validation/continuous/protocol.json',
        'initialProtocolSha256': 'validation/continuous/protocol-initial.json',
        'kineticsReferenceSha256': 'validation/continuous/kinetics-reference.json',
        'experimentScriptSha256': 'backend/experiments.py',
        'buildScriptSha256': 'scripts/modelica/build.py',
        'packagingScriptSha256': 'scripts/modelica/package_fmu.py',
    }
    for key, relative in bindings.items():
        if manifest.get(key) != sha(ROOT / relative):
            raise RuntimeError(f'Continuous manifest {key} differs from source; rebuild before verification.')
    started = time.perf_counter()
    checks, scenarios, runtime = [], [], {}
    limits = protocol['fullTrajectory']

    def add(name, value, tolerance, unit='1', category='numerical-verification', **evidence):
        value, tolerance = float(value), float(tolerance)
        passed = math.isfinite(value) and math.isfinite(tolerance) and abs(value) <= tolerance
        checks.append(dict(name=name, value=value, absoluteTolerance=tolerance, unit=unit,
                           category=category, **{'pass': passed}, evidence=evidence))
        print(('PASS ' if passed else 'FAIL ') + name + f': {value:.8g} {unit} (limit {tolerance:g})', flush=True)

    def scenario(identifier, name, duration, schedule=None, **kwargs):
        nonlocal runtime
        print(f'RUN  {identifier}: {duration:g} simulated seconds', flush=True)
        result = execute(fmu_path, duration, **kwargs)
        runtime = result['runtime']
        channels = tuple(result['points'][0])
        scope = 'All declared continuous-plant scalar outputs'
        if identifier.startswith(('source-', 'kinetics-', 'critical-', 'cats-')):
            channels = ('time', *KINETIC_OUTPUTS, 'reactivityPcm', 'rodReactivityPcm',
                        'externalSourceFractionPerSecond', 'fissionPowerMW', 'decayHeatMW', 'reactorPowerMW')
            scope = 'Kinetic states and thermal-source diagnostics; no plant-trajectory claim for this isolated case'
        elif identifier.startswith('sync-'):
            channels = ('time', 'turbineRpm', 'rotorEnergyMJ', 'frequencyDifferenceHz', 'phaseDifferenceDeg',
                        'generatorVoltagePu', 'gridConnected', 'syncPermissive', 'synchronizationDwellS',
                        'breakerClosingTimeS', 'breakerClosingFrequencyHz', 'breakerClosingPhaseDeg',
                        'breakerClosingVoltagePu', 'breakerClosingDwellS', 'reactorTripped', 'turbineTripped',
                        'neutronPowerFraction')
            scope = 'Primitive shaft/electrical states and synchronization diagnostics for isolated permissive checks'
        scenarios.append(dict(id=identifier, name=name, complete=True, durationSeconds=duration,
            trace=[{key:point[key] for key in channels} for point in result['points']],
            retainedChannels=list(channels), traceScope=scope, stepSeconds=result['stepSeconds'],
            sampleIntervalSeconds=kwargs.get('sample_interval', 30),
            parameters=result['parameters'], runtime=runtime,
            solverRelativeTolerance=result['solverRelativeTolerance'],
            boundaryQuadrature=result['integrals'], singleFmuInstance=True, resetCount=0,
            controlSchedule=schedule if schedule is not None else [{'time': 0, 'controls': kwargs.get('forcing', startup_inputs)(0)}]))
        add(name + ' retains finite nonnegative kinetic states',
            min(0, min(p[k] for p in result['points'] for k in KINETIC_OUTPUTS)), 0)
        return result

    def balances(name, result):
        points = result['points']; initial = points[0]; last = points[-1]
        de = last['totalPlantStoredEnergyMJ'] - initial['totalPlantStoredEnergyMJ']
        dm = last['totalPlantMassKg'] - initial['totalPlantMassKg']
        add(name + ' stored energy vs native integrated boundary',
            de - (last['integratedPlantBoundaryEnergyMJ'] - initial['integratedPlantBoundaryEnergyMJ']),
            limits['nativeEnergyInventoryAbsoluteToleranceMJ'], 'MJ')
        add(name + ' stored mass vs native integrated boundary',
            dm - (last['integratedPlantBoundaryMassKg'] - initial['integratedPlantBoundaryMassKg']),
            limits['nativeMassInventoryAbsoluteToleranceKg'], 'kg')
        add(name + ' stored energy vs independent boundary quadrature', de-result['integrals']['externalEnergyMJ'],
            limits['independentBoundaryQuadratureEnergyAbsoluteToleranceMJ'], 'MJ')
        add(name + ' stored mass vs independent boundary quadrature', dm-result['integrals']['externalMassKg'],
            limits['independentBoundaryQuadratureMassAbsoluteToleranceKg'], 'kg')
        add(name + ' instantaneous energy balance', max(abs(p['plantEnergyResidualMW']) for p in points),
            limits['instantaneousEnergyResidualAbsoluteToleranceMW'], 'MW')
        add(name + ' instantaneous mass balance', max(abs(p['plantMassResidualKgS']) for p in points),
            limits['instantaneousMassResidualAbsoluteToleranceKgS'], 'kg/s')
        for prefix, volume in [('pressurizer', 50), ('secondary', 300)]:
            add(name + f' {prefix} independent gas EOS closure',
                max(abs(physical_gas_eos_residual(p, prefix, volume)) for p in points),
                limits['gasEquationAbsoluteTolerancePa'], 'Pa')
        # The design inertia is fixed independently of native rotor-energy output.
        inertia = 2 * 4200e6 / (3000 * math.pi / 30) ** 2
        add(name + ' rotor energy from primitive speed',
            max(abs(p['rotorEnergyMJ']-rotor_energy_mj(p['turbineRpm'], inertia)) for p in points),
            protocol['synchronization']['rotorEnergyIdentityAbsoluteToleranceMJ'], 'MJ')
        # A state handoff could conserve the terminal ledger by accident; inspect
        # every retained interval, including criticality and breaker transitions.
        add(name + ' energy inventory continuity throughout trajectory',
            max(abs((p['totalPlantStoredEnergyMJ']-initial['totalPlantStoredEnergyMJ'])-
                    (p['integratedPlantBoundaryEnergyMJ']-initial['integratedPlantBoundaryEnergyMJ'])) for p in points),
            limits['nativeEnergyInventoryAbsoluteToleranceMJ'], 'MJ')
        add(name + ' mass inventory continuity throughout trajectory',
            max(abs((p['totalPlantMassKg']-initial['totalPlantMassKg'])-
                    (p['integratedPlantBoundaryMassKg']-initial['integratedPlantBoundaryMassKg'])) for p in points),
            limits['nativeMassInventoryAbsoluteToleranceKg'], 'kg')

    def full_conditions(name, result):
        points = result['points']; initial = points[0]
        end = points[-1]['time']; dwell = [p for p in points if p['time'] >= end-limits['requiredFinalDwellSeconds']]
        add(name + ' starts with cold native thermal inventories',
            max(abs(initial[k]-40) for k in ('hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC',
                                           'pressurizerTemperatureC','secondaryTemperatureC')),
            limits['requiredInitialPrimaryTemperatureToleranceK'], 'K')
        add(name + ' starts at rest, off grid and subcritical',
            0 if initial['turbineRpm'] == 0 and initial['gridConnected'] == 0 and initial['reactivityPcm'] < 0 else 1, 0)
        for channel, bounds in [('netPowerMW', limits['finalNetPowerRangeMW']),
                                 ('neutronPowerFraction', limits['finalNeutronPowerFractionRange'])]:
            add(name + f' final 600 seconds {channel} band',
                max(0, max(bounds[0]-p[channel] for p in dwell), max(p[channel]-bounds[1] for p in dwell)), 0,
                acceptedRange=bounds, observedRange=[min(p[channel] for p in dwell),max(p[channel] for p in dwell)])
        add(name + ' final 600 seconds synchronized', max(abs(1-p['gridConnected']) for p in dwell), 0)
        add(name + ' source-free sustained final power', max(abs(p['externalSourceFractionPerSecond']) for p in dwell), 0)
        add(name + ' retains primary liquid subcooling', max(0, limits['minimumPrimarySubcoolingK']-min(p['primarySubcoolingK'] for p in points)), 0, 'K')
        add(name + ' actually crosses into positive reactivity', 0 if any(p['reactivityPcm']>0 for p in points) else 1, 0)
        add(name + ' uses native fission heat throughout',
            max(abs(p['fissionPowerMW']-.934*3000*p['neutronPowerFraction']) for p in points), 1e-9, 'MW')
        closure=points[-1]
        add(name + ' closes only inside the electrical synchronization window',
            0 if (closure['breakerClosingTimeS']>=20000 and
                  abs(closure['breakerClosingFrequencyHz'])<=.002 and
                  abs(closure['breakerClosingPhaseDeg'])<=.5 and
                  abs(closure['breakerClosingVoltagePu']-1)<=.01 and
                  closure['breakerClosingDwellS']>=5) else 1,0,
            closingTimeSeconds=closure['breakerClosingTimeS'],
            frequencyDifferenceHz=closure['breakerClosingFrequencyHz'],
            phaseDifferenceDeg=closure['breakerClosingPhaseDeg'],
            voltagePu=closure['breakerClosingVoltagePu'],dwellSeconds=closure['breakerClosingDwellS'])

    try:
        probes = [
            ('source-equilibrium', 'Subcritical source equilibrium', -2000, 1e-8, 2e-6, 30),
            ('kinetics-step-negative', 'Negative reactivity with constant source', -50, 1e-4, 2e-6, 10),
            ('kinetics-step-positive', 'Positive reactivity with constant source', 20, 1e-4, 2e-6, 10),
            ('critical-equilibrium', 'Source-free critical equilibrium', 0, 1e-4, 0, 30),
        ]
        for identifier, name, rho, neutron, source, duration in probes:
            result = scenario(identifier, name, duration, step=.05, sample_interval=.5,
                forcing=constant_inputs(rodDemandPcm=rho, sourceEnable=float(source>0)),
                parameters={'thermalFeedbackScale': 0, 'initialRodReactivityPcm':rho, 'initialNeutronFraction': neutron,
                            'sourceStrengthFractionPerSecond': source}, integrate_boundary=False)
            error, comparisons = maximum_relative_kinetics_error(result['points'], rho, source, neutron)
            equilibrium = identifier in ('source-equilibrium', 'critical-equilibrium')
            add(name + ' against independent augmented matrix exponential', error,
                protocol['kinetics']['equilibriumRelativeTolerance' if equilibrium else 'matrixExponentialRelativeTolerance'],
                category='analytic-kinetics', comparisons=comparisons)
        removal = scenario('source-removal', 'Subcritical source removal', 60, step=.05, sample_interval=.5,
            forcing=lambda t: constant_inputs(rodDemandPcm=-2000, sourceEnable=float(t<30))(t),
            event_times=(30,), parameters={'thermalFeedbackScale': 0}, integrate_boundary=False,
            schedule=[{'time':0,'controls':constant_inputs(rodDemandPcm=-2000)(0)},
                      {'time':30,'controls':{'sourceEnable':0}}])
        removal_points = [{**p, 'time':p['time']-30} for p in removal['points'] if p['time']>=30]
        error, comparisons = maximum_relative_kinetics_error(removal_points, -2000, 0, 1e-8)
        add('Native source removal follows independent source-free kinetics', error,
            protocol['kinetics']['matrixExponentialRelativeTolerance'], category='analytic-kinetics', comparisons=comparisons)
        for case in published['cases']:
            parameters = {'thermalFeedbackScale':0, 'initialRodReactivityPcm':case['reactivityPcm'],
                          'initialNeutronFraction':published['initialNeutronFraction'],
                          'generationTimeSeconds':published['generationTimeSeconds']}
            parameters.update({f'beta[{i}]':v for i,v in enumerate(published['delayedFractions'],1)})
            parameters.update({f'lambda[{i}]':v for i,v in enumerate(published['decayConstantsPerSecond'],1)})
            result = scenario(case['id'], case['id'], 200, step=.05, sample_interval=.1,
                forcing=constant_inputs(rodDemandPcm=case['reactivityPcm'],sourceEnable=0),
                parameters=parameters, integrate_boundary=False)
            observed = {round(p['time'],8):p for p in result['points']}
            for seconds, expected in case['samples']:
                actual = observed[round(seconds,8)]['neutronPowerFraction']/published['initialNeutronFraction']
                add(case['id'] + f' published CATS at {seconds:g} seconds', abs(actual-expected)/expected,
                    published['relativeTolerance'], category='published-kinetics', actual=actual, expected=expected,
                    source=published['source'])
        # Initialized mechanical/electrical states are physically admissible;
        # no output or state is overwritten after the FMU has initialized.
        for identifier, speed, phase, voltage, accept in [
            ('sync-reject-speed',2970,0,1,False), ('sync-reject-phase',3000,180,1,False),
            ('sync-reject-voltage',3000,0,.8,False), ('sync-accept',3000,0,1,True)]:
            result = scenario(identifier, identifier, 10, step=.05, sample_interval=.05,
                forcing=constant_inputs(gridBreakerCommand=1, excitationCommandPu=voltage/(speed/3000)),
                parameters={'initialTurbineRpm':speed,'initialPhaseDifferenceDeg':phase,
                            'initialGeneratorVoltagePu':voltage,'nominalShaftFrictionMW':0},
                integrate_boundary=False)
            points=result['points']
            initial=points[0]
            good_speed=abs(initial['frequencyDifferenceHz'])<=.002
            good_phase=abs(initial['phaseDifferenceDeg'])<=.5
            good_voltage=abs(initial['generatorVoltagePu']-1)<=.01
            expected={'sync-reject-speed':(False,True,True),'sync-reject-phase':(True,False,True),
                      'sync-reject-voltage':(True,True,False),'sync-accept':(True,True,True)}[identifier]
            add(identifier + ' isolates the intended initial electrical condition',
                0 if (good_speed,good_phase,good_voltage)==expected else 1,0,
                frequencyDifferenceHz=initial['frequencyDifferenceHz'],phaseDifferenceDeg=initial['phaseDifferenceDeg'],
                voltagePu=initial['generatorVoltagePu'])
            add(identifier + ' electrical permissive outcome',
                abs(points[-1]['gridConnected']-float(accept)) if accept else max(p['gridConnected'] for p in points),0)
            add(identifier + ' no speed reset at breaker closure', max(abs(p['turbineRpm']-speed) for p in points),1e-6,'rpm')
            if accept:
                first=next((p['time'] for p in points if p['gridConnected']>.5),None)
                add('Synchronization requires native dwell before acceptance',0 if first is not None and first>=5 else 1,0,
                    firstConnectionSeconds=first)
                add('Synchronization does not reset the electrical angle',max(abs(p['phaseDifferenceDeg']) for p in points),1e-6,'deg')
        stop=scenario('trip-stop-valve','Finite emergency stop-valve closure',3,step=.05,sample_interval=.05,
            forcing=lambda t:constant_inputs(turbineTripCommand=float(t>=1))(t),
            event_times=(1,),integrate_boundary=False,
            schedule=[{'time':0,'controls':constant_inputs()(0)},
                      {'time':1,'controls':{'turbineTripCommand':1}}])
        add('Native stop valve follows the independent 0.2-second exponential',
            max(abs(p['stopValveFraction']-(1 if p['time']<=1 else math.exp(-(p['time']-1)/.2))) for p in stop['points']),
            STOP_VALVE_ABSOLUTE_TOLERANCE,category='analytic-actuator',
            reference='Initially armed at one; trip at 1 s; x(t)=exp(-(t-1)/0.2) after the trip.')
        schedule=declared_schedule()
        events=tuple(event['time'] for event in schedule if event['time']>0)
        startup=scenario('full-startup','Continuous native cold-to-full power',27000,step=.5,
                         forcing=startup_inputs,event_times=events,schedule=schedule)
        refined=scenario('full-startup-refined','Continuous startup communication refinement',27000,step=.25,
                         forcing=startup_inputs,event_times=events,schedule=schedule)
        for name,result in [('Continuous startup',startup),('Refined startup',refined)]:
            balances(name,result);full_conditions(name,result)
        pairs=retained_pairs(startup['points'],refined['points'])
        for channel,tolerance,unit in [
            *[(k,limits['maximumThermalRefinementDifferenceK'],'K') for k in
              ('hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC','pressurizerTemperatureC','secondaryTemperatureC')],
            *[(k,limits['maximumPressureRefinementDifferenceMPa'],'MPa') for k in ('primaryPressureMPa','secondaryPressureMPa')],
            ('netPowerMW',limits['maximumNetPowerRefinementDifferenceMW'],'MW'),
            ('turbineRpm',limits['maximumTurbineRefinementDifferenceRpm'],'rpm'),
            ('neutronPowerFraction',limits['maximumNeutronFractionRefinementDifference'],'1')]:
            add('Full-startup 0.5 vs 0.25 second refinement: '+channel,
                max(abs(a[channel]-b[channel]) for a,b in pairs),tolerance,unit)
        trip_schedule=declared_schedule(trip=True)
        trip=scenario('startup-trip','Same-instance full startup then reactor trip',27600,step=.5,
                      forcing=trip_inputs,event_times=(*events,27000),schedule=trip_schedule)
        balances('Full startup then trip',trip)
        before=next(p for p in trip['points'] if p['time']==27000);after=trip['points'][-1]
        add('Trip latches in the same native instance',abs(1-after['reactorTripped']),0)
        add('Trip opens the generator breaker',after['gridConnected'],0)
        add('Trip closes the independent steam stop valve',
            max(abs(p['stopValveFraction']) for p in trip['points'] if p['time']>=27030),
            STOP_VALVE_ABSOLUTE_TOLERANCE)
        add('Trip reduces neutron population and retains decay heat',
            0 if 0<after['neutronPowerFraction']<before['neutronPowerFraction']*.01 and after['decayHeatMW']>0 else 1,0,
            beforeNeutronFraction=before['neutronPowerFraction'],afterNeutronFraction=after['neutronPowerFraction'],
            retainedDecayHeatMW=after['decayHeatMW'])
    except Exception as error:
        add('Continuous verification completes without native runtime/domain failure',1,0,
            error=type(error).__name__,message=str(error),terminalObservation=getattr(error,'observation',None))
    report=dict(schemaVersion=1,version=json.loads((ROOT/'package.json').read_text())['version'],
        generatedAt=datetime.now(timezone.utc).isoformat(),gitRevision=git_value('rev-parse','HEAD'),
        gitDirty=bool(git_value('status','--porcelain')),runtime=runtime,buildManifest=manifest,
        protocol={'path':'validation/continuous/protocol.json','sha256':sha(PROTOCOL_PATH),'data':protocol},
        publishedKineticsReference={'path':'validation/continuous/kinetics-reference.json','sha256':sha(REFERENCE_PATH)},
        operatingEnvelope='Generic reduced-order 40 C cold shutdown through source-driven kinetics, source-free criticality, shaft acceleration, electrical synchronization and 1,000 MWe operation in one native FMU. Equation and numerical verification only; no measured full-startup validation or licensed plant qualification.',
        physicalValidationPassed=False,checks=checks,passed=sum(c['pass'] for c in checks),total=len(checks),
        scenarios=scenarios,durationSeconds=time.perf_counter()-started)
    Path(output_path).parent.mkdir(parents=True,exist_ok=True)
    Path(output_path).write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print(f"{report['passed']}/{report['total']} continuous-native checks passed. Evidence: {output_path}",flush=True)
    return 0 if report['passed']==report['total'] else 1


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fmu',type=Path,default=ROOT/'artifacts/modelica/ContinuousPlant.fmu')
    parser.add_argument('--output',type=Path,default=ROOT/'artifacts/continuous-verification.json')
    args=parser.parse_args()
    raise SystemExit(verify(args.fmu,args.output))
