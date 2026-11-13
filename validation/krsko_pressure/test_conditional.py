"""Attacks on the separately frozen, explicitly conditional spray comparison."""
# SPDX-License-Identifier: Apache-2.0
import copy
import hashlib
import unittest

from test_report import case, fixture


def conditional_fixture(originals):
    """Synthetic old trajectories exercise audit contracts, never native evidence."""
    cases = []
    controller = case.spray.configuration()['controller']
    for planned in case.spray.case_plans():
        item = copy.deepcopy(originals[1])
        item.update(planned)
        fmu_hash = hashlib.sha256(('synthetic '+planned['model']).encode()).hexdigest()
        item['buildManifest'] = {'model': planned['model'], 'fmuSha256': fmu_hash}
        for label in ('nominal', 'refined'):
            run = item[label]
            run['caseId'] = planned['id']
            run['parameters'] = case.spray.parameters(planned, case.applied_parameters())
            run['runtime'].update(model=planned['model'], fmuSha256=fmu_hash)
            for point in run['points']:
                point['sprayControlEnabled'] = 1
                point['actualSprayFlowKgS'] = controller['maximumSprayFlowKgS']*min(1, max(0,
                    planned['gainFractionPerMPa']*(point['primaryPressureMPa']-controller['referencePressureMPa'])))
        item['channels'] = case.channels_for(item['nominal'], item['refined'])
        item['numericalChecks'] = case.case_numerical_checks(item)
        item['numericalPassed'] = all(check['pass'] for check in item['numericalChecks'])
        cases.append(item)
    mesh = case.spray.mesh_checks(case.core_api(), cases)
    checks = [check for item in cases for check in item['numericalChecks']]+mesh
    guards = [{'id': item['id'], 'pairedGuards': case.reference.paired_improvement(item['channels'], originals[0]['channels'])} for item in cases]
    return {'configurationSha256': case.spray.CONFIG_SHA256, 'configuration': case.spray.configuration(),
        'executed': True, 'scope': case.spray.SCOPE,
        'physicalValidationPassed': False, 'independentValidationPassed': False,
        'actualPlantControlValidated': False, 'defaultPromotionRecommended': False,
        'caseImprovementPassed': False, 'status': 'conditional-development-no-improvement',
        'cases': cases, 'wallMeshChecks': mesh, 'numericalChecks': checks, 'numericalPassed': True,
        'sensitivityGuards': guards, 'pairedGuards': guards[0]['pairedGuards'],
        'channels': case.spray.displayed_channels(case.core_api(), cases, originals),
        'trace': cases[0]['nominal']['points'], 'runtime': cases[0]['nominal']['runtime'],
        'buildManifest': cases[0]['buildManifest']}


class ConditionalContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.originals = fixture()['cases']
        cls.fixture = conditional_fixture(cls.originals)

    def verify(self, report):
        return case.spray.verify_report(case.core_api(), report, self.originals)

    def test_complete_synthetic_contract_passes_without_physical_claim(self):
        self.assertTrue(self.verify(copy.deepcopy(self.fixture)))

    def test_omitting_adverse_sensitivity_rejected(self):
        report = copy.deepcopy(self.fixture)
        del report['cases'][2]
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_substituting_best_sensitivity_for_nominal_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['cases'][0], report['cases'][2] = report['cases'][2], report['cases'][0]
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_fitted_controller_parameter_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['cases'][0]['nominal']['parameters']['sprayReferencePressureMPa'] = 15.4
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_altered_displayed_sensitivity_rejected(self):
        report = copy.deepcopy(self.fixture)
        report['channels'][0]['points'][-1]['gainHigh'] -= .1
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_conditional_result_cannot_claim_measured_control_validation(self):
        report = copy.deepcopy(self.fixture)
        report['actualPlantControlValidated'] = True
        with self.assertRaises(ValueError):
            self.verify(report)


if __name__ == '__main__':
    unittest.main()
