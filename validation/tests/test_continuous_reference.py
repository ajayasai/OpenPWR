"""Independent checks of the native-startup mathematical reference machinery."""
# SPDX-License-Identifier: Apache-2.0
import math
import unittest

from backend.verify_continuous import (kinetics_reference, retained_pairs,
                                      rotor_energy_mj, load_reference_inputs)


class ContinuousReferenceTests(unittest.TestCase):
    def test_affine_source_exponential_agrees_with_scalar_closed_form(self):
        # With beta=0 the neutron equation decouples: dn/dt=-10 n+3.
        for seconds in (0, .01, .1, 1, 10):
            actual = kinetics_reference(seconds, .8, -100, 3,
                beta=(0,) * 6, generation=1e-4)[0]
            expected = .3 + .5 * math.exp(-10 * seconds)
            self.assertAlmostEqual(actual, expected, delta=3e-13)

    def test_source_equilibrium_and_critical_equilibrium_are_distinct(self):
        source = kinetics_reference(600, 1e-8, -2000, 2e-6)
        critical = kinetics_reference(600, 1e-4, 0, 0)
        self.assertLess(max(abs(x / 1e-8 - 1) for x in source), 2e-10)
        self.assertLess(max(abs(x / 1e-4 - 1) for x in critical), 2e-10)
        without_source = kinetics_reference(600, 1e-8, -2000, 0)
        self.assertLess(without_source[0], 1e-10)

    def test_rotor_energy_has_the_exact_quadratic_speed_scaling(self):
        inertia = 1000
        self.assertEqual(rotor_energy_mj(0, inertia), 0)
        self.assertAlmostEqual(rotor_energy_mj(3000, inertia), 5 * math.pi**2)
        self.assertAlmostEqual(rotor_energy_mj(1500, inertia), rotor_energy_mj(3000, inertia) / 4)

    def test_refinement_rejects_missing_or_duplicate_observation_times(self):
        coarse = [{'time': 0}, {'time': 1}]
        self.assertEqual(len(retained_pairs(coarse, [{'time': 0}, {'time': .5}, {'time': 1}])), 2)
        with self.assertRaises(ValueError): retained_pairs(coarse, [{'time': 0}, {'time': .9}])
        with self.assertRaises(ValueError): retained_pairs(coarse, [{'time': 0}, {'time': 1}, {'time': 1}])

    def test_prospective_protocol_and_published_values_retain_their_identity(self):
        protocol, data = load_reference_inputs()
        self.assertEqual(protocol['fullTrajectory']['communicationStepsSeconds'], [.5, .25])
        self.assertFalse(protocol['amendmentHistory'][0]['candidateScoringHadStarted'])
        self.assertEqual(sum(len(case['samples']) for case in data['cases']), 12)

    def test_independent_matrix_reference_reproduces_published_cats_values(self):
        _, data=load_reference_inputs()
        for case in data['cases']:
            for seconds, expected in case['samples']:
                actual=kinetics_reference(seconds,1,case['reactivityPcm'],0,
                    beta=data['delayedFractions'],decay=data['decayConstantsPerSecond'],
                    generation=data['generationTimeSeconds'])[0]
                self.assertLess(abs(actual/expected-1),1e-9,(case['id'],seconds))


if __name__ == '__main__': unittest.main()
