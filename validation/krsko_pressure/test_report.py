"""Pressure evidence contract attacks using explicitly synthetic case metadata."""
# SPDX-License-Identifier: Apache-2.0
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pressure_development_compare', Path(__file__).with_name('compare.py'))
case = importlib.util.module_from_spec(spec)
spec.loader.exec_module(case)


def fixture():
    """Reuse released numerical trajectories as synthetic, non-publishable fixtures.

    These are not executions of the candidate model. Their fake FMU identities
    cannot satisfy the filesystem/binary publication gate.
    """
    baseline, config, protocol = case.reference.baseline(), case.configuration(), case.reference.protocol()
    cases = []
    for planned in config['cases']:
        fmu_hash = hashlib.sha256(('synthetic fixture '+planned['model']).encode()).hexdigest()
        item = {**planned, 'buildManifest': {'model': planned['model'], 'fmuSha256': fmu_hash}}
        for label, source in [('nominal', 'primaryRun'), ('refined', 'refinedRun')]:
            run = copy.deepcopy(baseline[source])
            run['caseId'] = planned['id']
            run['parameters'] = case.applied_parameters()
            run['runtime']['model'] = planned['model']
            run['runtime']['fmuSha256'] = fmu_hash
            for point in run['points']:
                point.update(pressurizerLiquidTemperatureC=point['pressurizerTemperatureC'],
                    pressurizerVaporTemperatureC=point['pressurizerTemperatureC'],
                    pressurizerSteamPartialPressureMPa=point['primaryPressureMPa'],
                    pressurizerSaturationTemperatureC=case.saturation_temperature_k(point['primaryPressureMPa'])-273.15,
                    pressurizerWallEnergyMJ=0, pressurizerWallAmbientPowerW=0,
                    pressurizerWallMinimumTemperatureK=point['pressurizerTemperatureC']+273.15,
                    pressurizerWallMaximumTemperatureK=point['pressurizerTemperatureC']+273.15,
                    pressureModelFinitePhase=int(planned['finitePhase']), pressureModelIncludesWall=int(planned['wall']),
                    sprayControlEnabled=0, actualSprayFlowKgS=0, sprayCondensationKgS=0, sprayHeatTransferMW=0,
                    pressurizerMinimumFilmNusseltArgument=0)
            for segment in run['boundaryQuadrature']:
                segment['start']['pressurizerWallAmbientPowerW'] = 0
                segment['end']['pressurizerWallAmbientPowerW'] = 0
            item[label] = run
        item['channels'] = case.channels_for(item['nominal'], item['refined'])
        item['numericalChecks'] = case.case_numerical_checks(item)
        item['numericalPassed'] = all(check['pass'] for check in item['numericalChecks'])
        cases.append(item)
    reproduction, mesh = case.cross_case_checks(cases)
    checks = [check for item in cases for check in item['numericalChecks']]+reproduction+mesh
    guards = case.reference.paired_improvement(cases[1]['channels'], cases[0]['channels'])
    rows = case.reference.reference_rows()
    return {'schema': 'openpwr-krsko-pressure-development-v1', 'executed': True,
        'protocolSha256': case.reference.PROTOCOL_SHA256, 'protocol': protocol,
        'parameterSourcesSha256': case.CONFIG_SHA256, 'candidateConfiguration': config,
        'physicalValidationPassed': False, 'independentValidationPassed': False,
        'defaultPromotionRecommended': False, 'productionDefault': 'equilibrium',
        'baselineSha256': protocol['baseline']['sha256'], 'inputDataSha256': protocol['reference']['dataSha256'],
        'comparisonWindowS': [0, 15], 'fixedControlAssumptions': case.FIXED_CONTROLS.copy(),
        'releasedBaseline': protocol['baseline'], 'appliedSourceParameters': case.applied_parameters(),
        'cases': cases, 'channels': case.displayed_channels(cases),
        'baselineReproductionChecks': reproduction, 'wallMeshChecks': mesh,
        'numericalChecks': checks, 'numericalPassed': all(check['pass'] for check in checks),
        'pairedGuards': guards, 'caseImprovementPassed': guards['caseImprovementPassed'],
        'status': 'development-no-improvement', 'trace': copy.deepcopy(cases[1]['nominal']['points']),
        'runtime': cases[1]['nominal']['runtime'], 'buildManifest': cases[1]['buildManifest'],
        'inputs': [{'name': name, 'points': [{'time': time, 'value': case.reference.at(rows, time, name)} for time in range(16)]} for name in case.INPUTS]}


class PressureReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = fixture()

    def test_synthetic_integrity_fixture_passes_without_claiming_improvement(self):
        self.assertTrue(case.verify_original_report(copy.deepcopy(self.fixture)))
        self.assertFalse(self.fixture['caseImprovementPassed'])

    def test_displayed_ablation_cannot_be_forged(self):
        report = copy.deepcopy(self.fixture)
        report['channels'][0]['points'][3]['noWall'] += 1
        with self.assertRaises(ValueError):
            case.verify_original_report(report)

    def test_forged_pairwise_guard_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['pairedGuards']['checks'][0]['pass'] = True
        with self.assertRaises(ValueError):
            case.verify_original_report(report)

    def test_forged_wall_energy_boundary_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['cases'][1]['nominal']['boundaryQuadrature'][3]['start']['pressurizerWallAmbientPowerW'] = 1e6
        with self.assertRaises(ValueError):
            case.verify_original_report(report)

    def test_phase_domain_violation_is_independently_detected(self):
        point = copy.deepcopy(self.fixture['cases'][1]['nominal']['points'][0])
        point['pressurizerVaporTemperatureC'] = 100
        self.assertIn('pressurizerVaporTemperatureC', case.domain_violations(point, self.fixture['cases'][1]))

    def test_native_energy_ledger_cannot_be_replaced_with_zero(self):
        report = copy.deepcopy(self.fixture)
        report['cases'][1]['nominal']['nativeEnergyIntegralErrorMJ'] = 123
        with self.assertRaises(ValueError):
            case.verify_original_report(report)

    def test_default_promotion_cannot_be_inferred_from_numerical_success(self):
        report = copy.deepcopy(self.fixture)
        report['defaultPromotionRecommended'] = True
        with self.assertRaises(ValueError):
            case.verify_original_report(report)

    def test_full_audit_requires_history_components_and_spray(self):
        with self.assertRaises(ValueError):
            case.verify_report(copy.deepcopy(self.fixture))

    def test_negative_accepted_wall_radicand_rejected(self):
        point = copy.deepcopy(self.fixture['cases'][1]['nominal']['points'][0])
        point['pressurizerMinimumFilmNusseltArgument'] = -1
        self.assertIn('pressurizerMinimumFilmNusseltArgument', case.domain_violations(point, self.fixture['cases'][1]))

    def test_spray_flow_must_follow_frozen_native_feedback(self):
        plan = case.spray.case_plans()[0]
        point = copy.deepcopy(self.fixture['cases'][1]['nominal']['points'][0])
        point['sprayControlEnabled'] = 1
        point['primaryPressureMPa'] = 15.6
        point['actualSprayFlowKgS'] = 20.67*2*(15.6-15.51)
        self.assertNotIn('actualSprayFlowKgS', case.domain_violations(point, plan))
        point['actualSprayFlowKgS'] = 0
        self.assertIn('actualSprayFlowKgS', case.domain_violations(point, plan))


if __name__ == '__main__':
    unittest.main()
