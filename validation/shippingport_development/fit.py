# SPDX-License-Identifier: Apache-2.0
"""Re-estimate the five constant heat/vent amplitudes using development readings only."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import json

import numpy as np

from assess import development_data
from run_native import CASE, execute
from validation.native_fmi import NativeDomainExit


FIELDS = ('effectiveHeatMW', 'effectiveHeatMW', 'heaterPowerMW', 'ventFraction', 'heaterPowerMW')
INITIAL = np.array([3.6, 17.5, .58, .10, 1.1])
UPPER = np.array([100., 100., 3., 1., 3.])


def residuals(parameters):
    case = json.loads(CASE.read_text())
    if len(case['intervals']) != len(FIELDS):
        raise ValueError('Expected five phase amplitudes.')
    for interval, field, value in zip(case['intervals'], FIELDS, parameters):
        if field not in interval:
            raise ValueError(f'Unexpected interval for {field}.')
        interval[field] = float(value)
    try:
        points = execute(case)['points']
    except NativeDomainExit:
        return None
    grid = [p['time'] for p in points]
    all_errors = []
    for channel in development_data()['channels']:
        is_pressure = channel['key'] == 'primaryPressure'
        field = 'primaryPressureMPa' if is_pressure else 'averageCoolantTemperature'
        readings = [p for p in channel['points'] if p['split'] == 'development']
        predicted = np.interp([p['elapsedS'] for p in readings], grid, [p[field] for p in points])
        # The objective is the sum of channel mean square errors divided by
        # squared working scales. These are fitting weights, not sensor uncertainties.
        scale = (1. if is_pressure else 10.) * np.sqrt(len(readings))
        all_errors.extend((predicted - [p['value'] for p in readings]) / scale)
    return np.array(all_errors)


def fit(workers):
    parameters = INITIAL.copy()
    errors = residuals(parameters)
    if errors is None:
        raise RuntimeError('Initial parameter vector leaves the native model domain.')
    history = [float(errors @ errors)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for _ in range(5):
            delta = np.maximum(.005, parameters*.012)
            columns = list(pool.map(residuals, parameters + np.diag(delta)))
            if any(column is None for column in columns):
                raise RuntimeError('A derivative probe exited the model domain.')
            jacobian = np.column_stack([(column-errors)/h for column, h in zip(columns, delta)])
            direction = np.linalg.lstsq(jacobian, -errors, rcond=None)[0]
            trial = np.clip(parameters + np.clip(direction, -.35*parameters, .5*parameters), .0001, UPPER)
            for _ in range(12):
                next_errors = residuals(trial)
                if next_errors is not None and next_errors @ next_errors < history[-1]:
                    parameters, errors = trial, next_errors
                    history.append(float(errors @ errors))
                    break
                trial = .5*(parameters+trial)
            else:
                break
    return {'start': INITIAL.tolist(), 'amplitudes': np.round(parameters, 5).tolist(), 'objectives': history}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=1, choices=range(1, 6))
    print(json.dumps(fit(parser.parse_args().workers), indent=2))
