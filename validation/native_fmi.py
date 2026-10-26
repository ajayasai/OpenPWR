"""Shared native benchmark build and execution helpers; no fitted parameters."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMMON = ROOT / 'models/OpenPWR/package.mo'
sys.path.insert(0, str(ROOT / 'scripts/modelica'))
from package_fmu import add_notices


class NativeDomainExit(RuntimeError):
    """A declared model-domain stop; preserve its finite terminal observation."""
    def __init__(self, observation):
        self.observation = observation
        super().__init__(f'Native reference domain exit at {observation["time"]:g} s.')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_case(model_name, model_path, fmu_path, manifest_path, identity, resources=()):
    """Compile in a fresh directory and bind the artifact to exact source bytes."""
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    compiler = os.environ.get('OPENPWR_OMC', 'omc')
    compiler_version = subprocess.check_output([compiler, '--version'], text=True).strip()
    before = identity()
    fmu_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openpwr-reference-') as work:
        script = Path(work) / 'build.mos'
        script.write_text('\n'.join([
            'installPackage(Modelica, "4.0.0", exactMatch=true);', 'getErrorString();',
            'loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);',
            f'loadFile({json.dumps(COMMON.as_posix())});',
            f'loadFile({json.dumps(model_path.as_posix())});', 'getErrorString();',
            'setCommandLineOptions("--fmiFlags=s:cvode --fmuRuntimeDepends=modelica");',
            f'buildModelFMU({model_name}, version="2.0", fmuType="cs", fileNamePrefix={json.dumps(fmu_path.stem)});',
            'getErrorString();']), encoding='utf-8')
        result = subprocess.run([compiler, str(script)], cwd=work, capture_output=True, text=True, timeout=600)
        log = result.stdout + '\n' + result.stderr
        for detail in sorted(Path(work).glob('*_FMU.log')):
            log += '\n' + detail.name + '\n' + detail.read_text(errors='replace')
        (fmu_path.parent / (fmu_path.stem + '-build.log')).write_text(log, encoding='utf-8')
        after = identity()
        if any(after.get(key) != value for key, value in before.items() if key.endswith('Sha256')):
            raise RuntimeError('A benchmark source changed during compilation; rebuild from stable sources.')
        candidate = Path(work) / fmu_path.name
        if result.returncode or not candidate.is_file():
            raise RuntimeError(f'Native compilation failed; read {fmu_path.stem}-build.log.')
        fmu_path.write_bytes(candidate.read_bytes())
        add_notices(fmu_path)
        with zipfile.ZipFile(fmu_path, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(model_path, 'sources/OpenPWR/' + model_path.name)
            for path, target in resources:
                archive.write(path, target)
        manifest = {**before, 'model': model_name, 'compiler': compiler_version,
                    'fmuSha256': sha(fmu_path), 'fmiVersion': '2.0', 'modelicaLibrary': '4.0.0',
                    'hostPlatform': platform.platform()}
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        return manifest


def run_case(fmu_path, model_name, output_names, input_names, forcing, duration, step,
             parameters=None, sample_interval=1.0, event_times=(), boundary_integrals=(),
             solver_tolerance=1e-9):
    """Execute a case with explicit held inputs and independent boundary quadrature.

    Every event is an exact communication boundary. Outputs are requested only
    after doStep: FMI setReal does not promise to recalculate derived outputs.
    The boundary callback receives the held inputs and endpoint observations;
    it can integrate an externally imposed mass flow exactly without using a
    potentially stale algebraic output. Each pair is (name, callback).
    """
    from fmpy import extract, read_model_description
    from fmpy.fmi2 import FMU2Slave

    if not math.isfinite(step) or step <= 0 or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Duration and step must be finite and positive.')
    if not math.isfinite(solver_tolerance) or not 0 < solver_tolerance < 1:
        raise ValueError('Solver relative tolerance must be finite and between zero and one.')
    description = read_model_description(str(fmu_path), validate=True)
    if description.modelName != model_name:
        raise ValueError('Unexpected benchmark FMU identity.')
    declared_raw = getattr(getattr(description, 'defaultExperiment', None), 'tolerance', None)
    try:
        declared_tolerance = float(declared_raw)
    except (TypeError, ValueError):
        declared_tolerance = float('nan')
    if not math.isfinite(declared_tolerance) or not math.isclose(declared_tolerance, solver_tolerance, rel_tol=1e-12):
        raise ValueError('FMU DefaultExperiment tolerance differs from the requested solver tolerance; rebuild the model annotation. OpenModelica CVODE may ignore setupExperiment overrides.')
    variables = {variable.name: variable for variable in description.modelVariables}
    for name in (*output_names, *input_names, *(parameters or {})):
        if name not in variables:
            raise ValueError(f'Missing native benchmark variable: {name}')
    input_refs = [variables[name].valueReference for name in input_names]
    output_refs = [variables[name].valueReference for name in output_names]
    sample_count = round(duration / sample_interval)
    if abs(sample_count * sample_interval - duration) > 1e-8:
        raise ValueError('Duration must end on a retained sample time.')
    boundaries = sorted(set([0.0, duration, *[i * sample_interval for i in range(1, sample_count)], *event_times]))
    if any(not math.isfinite(time) or not 0 <= time <= duration for time in boundaries):
        raise ValueError('Invalid event time.')
    directory, slave = extract(str(fmu_path)), None
    integrals = {name: 0.0 for name, _ in boundary_integrals}
    steps = 0
    try:
        slave = FMU2Slave(guid=description.guid, unzipDirectory=directory,
            modelIdentifier=description.coSimulation.modelIdentifier, instanceName='OpenPWRReference')
        slave.instantiate(); slave.setupExperiment(startTime=0, tolerance=solver_tolerance)
        slave.enterInitializationMode()
        if parameters:
            for kind, setter in [('Real', slave.setReal), ('Integer', slave.setInteger), ('Boolean', slave.setBoolean)]:
                selected = [(name, value) for name, value in parameters.items() if variables[name].type == kind]
                if not selected:
                    continue
                if any((type(value) is not bool if kind == 'Boolean' else
                        type(value) not in (int, float) or not math.isfinite(value) or
                        (kind == 'Integer' and value != int(value))) for _, value in selected):
                    raise ValueError(f'Invalid {kind} benchmark parameter.')
                setter([variables[name].valueReference for name, _ in selected], [value for _, value in selected])
            if any(variables[name].type not in ('Real', 'Integer', 'Boolean') for name in parameters):
                raise ValueError('Unsupported benchmark parameter type.')

        def inputs(time):
            values = forcing(time)
            if set(values) != set(input_names) or any(not math.isfinite(value) for value in values.values()):
                raise ValueError('Forcing must provide exactly the declared finite inputs.')
            return values

        held = inputs(0)
        slave.setReal(input_refs, [held[name] for name in input_names])
        slave.exitInitializationMode()

        def observation(time):
            values = list(map(float, slave.getReal(output_refs)))
            if any(not math.isfinite(value) for value in values):
                raise RuntimeError(f'Nonfinite native output at {time:g} s.')
            point = {'time': time, **dict(zip(output_names, values))}
            if 'valid' in variables and not slave.getBoolean([variables['valid'].valueReference])[0]:
                raise NativeDomainExit(point)
            return point

        previous = observation(0)
        points, current_time = [previous], 0.0
        for boundary in boundaries[1:]:
            while current_time < boundary - 1e-10:
                delta = min(step, boundary - current_time)
                held = inputs(current_time)
                slave.setReal(input_refs, [held[name] for name in input_names])
                status = slave.doStep(currentCommunicationPoint=current_time, communicationStepSize=delta)
                if status not in (None, 0, 1):
                    raise RuntimeError(f'FMI step failed with status {status}.')
                next_time = current_time + delta
                current_time = boundary if abs(next_time - boundary) < 1e-10 else next_time
                current = observation(current_time)
                for name, evaluate in boundary_integrals:
                    # Re-evaluate both endpoints using the SAME held inputs.
                    # This avoids integrating a fictitious ramp across a jump.
                    integrals[name] += .5 * delta * (evaluate(held, previous) + evaluate(held, current))
                previous = current
                steps += 1
            if abs(boundary / sample_interval - round(boundary / sample_interval)) < 1e-8:
                points.append(dict(previous))
        return {'points': points, 'integrals': integrals, 'steps': steps, 'stepSeconds': step,
                'solverRelativeTolerance': declared_tolerance,
                'requestedSolverRelativeTolerance': solver_tolerance,
                'solverToleranceBasis': 'FMU DefaultExperiment annotation, checked against the setupExperiment request; OpenModelica CVODE uses the compiled annotation.',
                'parameters': parameters or {}, 'runtime': {'model': description.modelName,
                    'fmuSha256': sha(fmu_path), 'compiler': description.generationTool,
                    'fmiVersion': description.fmiVersion}}
    finally:
        if slave is not None:
            try: slave.terminate()
            except Exception: pass
            try: slave.freeInstance()
            except Exception: pass
        shutil.rmtree(directory, ignore_errors=True)
