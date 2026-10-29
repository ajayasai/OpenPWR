"""Numerically verify the native cold-to-hot-standby model, not plant fidelity."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.profiles import PROFILES
from backend.verify import git_value, read_verified_manifest
from validation.native_fmi import run_case, NativeDomainExit, sha

INPUTS = tuple(PROFILES['cold']['limits'])
OUTPUTS = tuple(PROFILES['cold']['real_outputs'])

def startup_inputs(t):
    controls = dict(PROFILES['cold']['defaults'])
    controls.update(pumpCommand=1, startupHeatMW=15, shutdownCoolingFraction=0,
                    pressureControlEnable=1, pressureTargetMPa=15.5)
    controls['ventFraction'] = 1 if 3600 <= t < 7200 else 0
    return controls

def execute(fmu_path, duration, step=5, forcing=startup_inputs, sample_interval=60, parameters=None, event_times=()):
    return run_case(Path(fmu_path), 'ColdStartPlant', OUTPUTS, INPUTS, forcing,
                    duration, step, sample_interval=sample_interval,
                    event_times=tuple(t for t in (3600,7200,*event_times) if 0 < t < duration), solver_tolerance=1e-8,
                    parameters=parameters,
                    boundary_integrals=(('externalEnergyMJ',lambda u,p:boundary_flux(u,p)[0]),
                                        ('externalMassKg',lambda u,p:boundary_flux(u,p)[1])))

def boundary_flux(controls, point):
    """Rebuild boundary flux from held commands and endpoint physical states.

    FMI setters need not refresh algebraic outputs. Thus this deliberately
    ignores native boundary/actual-control outputs, including at control jumps.
    Native enthalpies are thermodynamic primitives at unchanged endpoint p,T;
    all controlled flows, feedback controls and work are evaluated independently.
    """
    clamp=lambda value,maximum:max(0,min(maximum,value))
    pressure=point['primaryPressureMPa']
    inventory=controls['inventoryControlEnable']>.5
    charging=controls['chargingFlowKgS']+(clamp(2*(50-point['pressurizerLevelPercent']),10) if inventory else 0)
    letdown=controls['letdownFlowKgS']+(clamp(2*(point['pressurizerLevelPercent']-50),20) if inventory else 0)
    automatic=controls['pressureControlEnable']>.5
    heater=clamp(3*(controls['pressureTargetMPa']-pressure),3) if automatic else controls['heaterPowerMW']
    vent=max(controls['ventFraction'],clamp(2*(pressure-controls['pressureTargetMPa']),1) if automatic else 0)
    def mixture_vent(prefix,pressure_pa,fraction,coefficient):
        gas=point[prefix+'GasMassKg'];steam=point[prefix+'VaporMassKg']
        flow=fraction*coefficient*math.sqrt(max(0,pressure_pa-101325)/200000)
        gas_flow=flow*gas/(gas+steam)
        steam_flow=flow-gas_flow
        enthalpy=point[prefix+'SteamEnthalpyJkg']
        power=steam_flow*enthalpy+gas_flow*1040*(point[prefix+'TemperatureC']+273.15)
        return flow,power
    primary_vent,primary_vent_power=mixture_vent('pressurizer',pressure*1e6,vent,.5)
    secondary_fraction=clamp((point['secondaryTemperatureC']-110)/1,1)*clamp((point['secondaryGasMassKg']-.05)/.05,1)
    secondary_vent,secondary_vent_power=mixture_vent('secondary',point['secondaryPressureMPa']*1e6,
        secondary_fraction,2)
    pump_power=12*point['pumpSpeed']**3
    shutdown_cooling=controls['shutdownCoolingFraction']*.5*max(0,point['coldLegTemperatureC']-30)
    energy=controls['startupHeatMW']+pump_power+heater-shutdown_cooling+(
        charging*point['chargingEnthalpyJkg']-letdown*point['coldLegEnthalpyJkg']-primary_vent_power-secondary_vent_power)/1e6
    return energy,charging-letdown-primary_vent-secondary_vent

def saturation_pressure_pa(temperature_k):
    """Independent transcription of IAPWS-IF97 Eq. 30, region 4, p(T)."""
    n=(1167.0521452767,-724213.16703206,-17.073846940092,12020.82470247,
       -3232555.0322333,14.91510861353,-4823.2657361591,405113.40542057,
       -0.23855557567849,650.17534844798)
    theta=temperature_k+n[8]/(temperature_k-n[9])
    a=theta*theta+n[0]*theta+n[1]
    b=n[2]*theta*theta+n[3]*theta+n[4]
    c=n[5]*theta*theta+n[6]*theta+n[7]
    return (2*c/(-b+math.sqrt(b*b-4*a*c)))**4*1e6

def eos_residual(point, secondary=False):
    prefix='secondary' if secondary else 'pressurizer'
    temperature=point[prefix+'TemperatureC']+273.15
    pressure=point['secondaryPressureMPa' if secondary else 'primaryPressureMPa']*1e6
    volume=300 if secondary else 50
    vapor_volume=volume*(1-point[prefix+'LevelPercent']/100)
    return pressure-saturation_pressure_pa(temperature)-point[prefix+'GasMassKg']*296.8*temperature/vapor_volume

def pump_energy_mj(seconds, command=1):
    """Integral of 12*speed^3, speed=command*(1-exp(-t/7))."""
    tau=7
    return 12*command**3*(seconds-3*tau*(1-math.exp(-seconds/tau))
                         +1.5*tau*(1-math.exp(-2*seconds/tau))-tau/3*(1-math.exp(-3*seconds/tau)))

def constant_inputs(**changes):
    controls=dict(PROFILES['cold']['defaults'])
    controls.update(shutdownCoolingFraction=0,inventoryControlEnable=0)
    controls.update(changes)
    return lambda _t: dict(controls)

def verify(fmu_path, output_path):
    manifest=read_verified_manifest(fmu_path,expected_model='ColdStartPlant',manifest_name='cold-manifest.json')
    source_bindings={'coldSourceSha256': ROOT/'models/ColdStartPlant.mo',
                     'verificationScriptSha256': Path(__file__),
                     'sharedRunnerSha256': ROOT/'validation/native_fmi.py',
                     'hostScriptSha256': ROOT/'backend/fmi_host.py',
                     'profileScriptSha256': ROOT/'backend/profiles.py'}
    for key,path in source_bindings.items():
        if manifest.get(key)!=sha(path):
            raise RuntimeError(f'Cold manifest {key} differs from current source; rebuild before verification.')
    started=time.perf_counter();checks=[];scenarios=[];runtime={}
    def add(name,value,tolerance,unit='1',**evidence):
        value=float(value);tolerance=float(tolerance)
        passed=math.isfinite(value) and math.isfinite(tolerance) and abs(value)<=tolerance
        checks.append(dict(name=name,value=value,absoluteTolerance=tolerance,unit=unit,**{'pass':passed},evidence=evidence))
        print(('PASS ' if passed else 'FAIL ')+name+f': {value:.8g} {unit} (limit {tolerance:g})',flush=True)
    def scenario(name,duration,**kwargs):
        nonlocal runtime
        result=execute(fmu_path,duration,**kwargs);runtime=result['runtime']
        ids={'closed cold equilibrium':'cold-equilibrium','pump heat and lag':'pump-fine',
             'pump 5-second communication refinement':'pump-coarse','nondefault 50 C initialization':'initialization-50c',
             'pumps-off charging and reverse leg flow':'charging','pumps-off letdown and reverse surge':'letdown',
             'continuous cold-to-hot standby':'startup','continuous startup 2.5-second refinement':'startup-refined',
             'same-instance startup then shutdown cooling':'startup-cooldown'}
        scenarios.append({'id':ids[name],'name':name,'complete':True,'durationSeconds':duration,'trace':result['points'],
                          'stepSeconds':result['stepSeconds'],'boundaryQuadrature':result['integrals'],
                          'parameters':result['parameters'],'solverRelativeTolerance':result['solverRelativeTolerance'],
                          'runtime':result['runtime'],'sampleIntervalSeconds':kwargs.get('sample_interval',60)})
        return result
    def balances(name,result,energy_limit=1,mass_limit=.05,quadrature_energy=50,quadrature_mass=5):
        p=result['points'];initial=p[0];last=p[-1]
        de=last['totalPlantStoredEnergyMJ']-initial['totalPlantStoredEnergyMJ']
        dm=last['totalPlantMassKg']-initial['totalPlantMassKg']
        add(name+' stored energy vs native integrated boundary',de-last['integratedPlantBoundaryEnergyMJ'],energy_limit,'MJ')
        add(name+' stored mass vs native integrated boundary',dm-last['integratedPlantBoundaryMassKg'],mass_limit,'kg')
        add(name+' stored energy vs independent boundary quadrature',de-result['integrals']['externalEnergyMJ'],quadrature_energy,'MJ')
        add(name+' stored mass vs independent boundary quadrature',dm-result['integrals']['externalMassKg'],quadrature_mass,'kg')
        add(name+' instantaneous energy balance',max(abs(x['plantEnergyResidualMW']) for x in p),1e-7,'MW')
        add(name+' instantaneous mass balance',max(abs(x['plantMassResidualKgS']) for x in p),1e-7,'kg/s')
        add(name+' pressurizer gas EOS closure',max(abs(eos_residual(x)) for x in p),50,'Pa')
        add(name+' secondary gas EOS closure',max(abs(eos_residual(x,True)) for x in p),50,'Pa')
    try:
        closed=scenario('closed cold equilibrium',600,forcing=constant_inputs(),sample_interval=60)
        add('Closed cold equilibrium temperature drift',max(abs(p[k]-40) for p in closed['points'] for k in
            ('hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC','pressurizerTemperatureC','secondaryTemperatureC')),1e-6,'K')
        balances('Closed cold equilibrium',closed,energy_limit=1e-5,mass_limit=1e-6,quadrature_energy=1e-5,quadrature_mass=1e-6)
        pump=scenario('pump heat and lag',600,step=.5,forcing=constant_inputs(pumpCommand=1),sample_interval=1)
        at7=pump['points'][7]
        add('Pump first-order lag at one time constant',at7['pumpSpeed']-(1-math.exp(-1)),2e-6)
        dp=pump['points'][-1]['totalPlantStoredEnergyMJ']-pump['points'][0]['totalPlantStoredEnergyMJ']
        add('Pump heating against exact integrated speed-cubed work',dp-pump_energy_mj(600),.02,'MJ')
        balances('Pump heat',pump,quadrature_energy=.1,quadrature_mass=.01)
        pumps_coarse=scenario('pump 5-second communication refinement',600,forcing=constant_inputs(pumpCommand=1),sample_interval=5)
        add('Pump heat 0.5 vs 5-second temperature refinement',max(abs(a['coldLegTemperatureC']-b['coldLegTemperatureC']) for a,b in zip(pump['points'][::5],pumps_coarse['points'])),.002,'K')
        variant=scenario('nondefault 50 C initialization',10,step=.5,forcing=constant_inputs(),sample_interval=1,
                         parameters={'initialTemperatureK':323.15})
        add('Every thermal inventory uses the initial-temperature parameter',max(abs(variant['points'][0][k]-50) for k in
            ('hotLegTemperatureC','coldLegTemperatureC','fuelTemperatureC','pressurizerTemperatureC','secondaryTemperatureC')),1e-8,'K')
        charge=scenario('pumps-off charging and reverse leg flow',120,forcing=constant_inputs(chargingFlowKgS=5),sample_interval=5)
        letdown=scenario('pumps-off letdown and reverse surge',120,forcing=constant_inputs(letdownFlowKgS=5),sample_interval=5)
        add('Pumps-off charging produces positive surge',0 if charge['points'][-1]['surgeFlowKgS']>0 else 1,0)
        add('Pumps-off letdown produces reverse surge',0 if letdown['points'][-1]['surgeFlowKgS']<0 else 1,0)
        balances('Pumps-off charging',charge,quadrature_energy=.1,quadrature_mass=.01)
        balances('Pumps-off letdown',letdown,quadrature_energy=.1,quadrature_mass=.01)
        startup=scenario('continuous cold-to-hot standby',18000)
        refined=scenario('continuous startup 2.5-second refinement',18000,step=2.5)
        balances('Continuous startup',startup)
        balances('Refined continuous startup',refined)
        for key,tolerance,unit in [('coldLegTemperatureC',.01,'K'),('primaryPressureMPa',.002,'MPa'),('secondaryPressureMPa',.002,'MPa')]:
            add('Startup 5 vs 2.5-second refinement: '+key,max(abs(a[key]-b[key]) for a,b in zip(startup['points'],refined['points'])),tolerance,unit)
        terminal=startup['points'][-1]
        add('Continuous startup reaches the declared hot-standby conditions',1-terminal['hotStandbyReady'],0,
            finalColdTemperatureC=terminal['coldLegTemperatureC'],finalPressureMPa=terminal['primaryPressureMPa'])
        add('Startup retains positive primary subcooling',0 if min(p['primarySubcoolingK'] for p in startup['points'])>3 else 1,0)
        add('Startup removes cover gas within the declared roundoff bound',0 if min(p['pressurizerGasMassKg'] for p in startup['points'])>=-1e-8 and terminal['pressurizerGasMassKg']<.1 and terminal['secondaryGasMassKg']<.1 else 1,0,minimumAcceptedGasKg=-1e-8)
        max_rate=max(abs(b['coldLegTemperatureC']-a['coldLegTemperatureC'])/(b['time']-a['time']) for a,b in zip(startup['points'],startup['points'][1:]))
        add('Startup temperature continuity (no state handoff)',max_rate,.03,'K/s',note='Same FMU instance throughout; no state reset or alternate-engine transition.')
        def cooldown_inputs(t):
            controls=startup_inputs(t)
            if t>=18000: controls.update(startupHeatMW=0,pumpCommand=.5,shutdownCoolingFraction=.3)
            return controls
        cooldown=scenario('same-instance startup then shutdown cooling',21600,forcing=cooldown_inputs,event_times=(18000,))
        balances('Startup then shutdown cooling',cooldown)
        at_hot=next(p for p in cooldown['points'] if p['time']==18000)
        cooling_drop=at_hot['coldLegTemperatureC']-cooldown['points'][-1]['coldLegTemperatureC']
        add('Shutdown cooling reverses the heatup in the same native instance',0 if cooling_drop>20 else 1,0,temperatureDropK=cooling_drop)
    except Exception as error:
        add('Native cold verification completes without runtime/domain failure',1,0,error=type(error).__name__,message=str(error),
            terminalObservation=getattr(error,'observation',None))
    report={'schemaVersion':1,'version':json.loads((ROOT/'package.json').read_text())['version'],
            'generatedAt':datetime.now(timezone.utc).isoformat(),'gitRevision':git_value('rev-parse','HEAD'),
            'gitDirty':bool(git_value('status','--porcelain')),'runtime':runtime,'buildManifest':manifest,
            'operatingEnvelope':'Continuous 40 C cold shutdown to generic hot standby with prescribed fuel heat; no neutron criticality, turbine synchronization, licensed operating procedure, or hot-FMU handoff.',
            'physicalValidationPassed':False,'checks':checks,'passed':sum(c['pass'] for c in checks),'total':len(checks),
            'scenarios':scenarios,'durationSeconds':time.perf_counter()-started}
    Path(output_path).parent.mkdir(parents=True,exist_ok=True)
    Path(output_path).write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print(f"{report['passed']}/{report['total']} cold-native checks passed. Evidence: {output_path}",flush=True)
    return 0 if report['passed']==report['total'] else 1

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fmu',type=Path,default=ROOT/'artifacts/modelica/ColdStartPlant.fmu')
    parser.add_argument('--output',type=Path,default=ROOT/'artifacts/cold-verification.json')
    args=parser.parse_args()
    raise SystemExit(verify(args.fmu,args.output))
