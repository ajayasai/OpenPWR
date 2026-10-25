// SPDX-License-Identifier: Apache-2.0
// Original implementations of public mathematical correlations; no third-party code.

export const GENERATION_TIME = 1e-4; // seconds, generic thermal reactor assumption
export const DELAYED_GROUPS = Object.freeze([
  { beta: 0.000215, lambda: 0.0124 },
  { beta: 0.001424, lambda: 0.0305 },
  { beta: 0.001274, lambda: 0.111 },
  { beta: 0.002568, lambda: 0.301 },
  { beta: 0.000748, lambda: 1.14 },
  { beta: 0.000273, lambda: 3.01 },
].map(Object.freeze));
export const DELAYED_FRACTION = DELAYED_GROUPS.reduce((sum, g) => sum + g.beta, 0);

/** Backward-Euler point kinetics, eliminating six precursor unknowns analytically.
 * precursors z_i = lambda_i * Lambda * C_i / beta_i, so z_i=n at equilibrium.
 * rhoPcm is reactivity in pcm (1 pcm = 1e-5 delta-k/k).
 * Uses a positivity-preserving implicit solve in the sub-prompt-critical domain.
 * Equations: ANL/NSE-21/6, section 6.1.1, https://publications.anl.gov/anlpubs/2021/05/166771.pdf
 */
export function stepKinetics(n, precursors, rhoPcm, dt) {
  if (!Number.isFinite(n) || n < 0 || !Array.isArray(precursors)
      || precursors.length !== 6 || precursors.some(x => !Number.isFinite(x) || x < 0)
      || !Number.isFinite(rhoPcm) || !Number.isFinite(dt) || dt <= 0) {
    throw new RangeError('Invalid point-kinetics state or time step');
  }
  let numerator = n;
  let denominator = 1 - dt * rhoPcm * 1e-5 / GENERATION_TIME;
  for (let i = 0; i < 6; i++) {
    const g = DELAYED_GROUPS[i];
    const factor = dt * g.beta / (GENERATION_TIME * (1 + dt * g.lambda));
    numerator += factor * precursors[i];
    denominator += factor;
  }
  if (denominator <= 0) throw new RangeError('Point-kinetics time step outside positivity domain');
  const nextN = numerator / denominator;
  return {
    n: nextN,
    precursors: precursors.map((z, i) => {
      const d = dt * DELAYED_GROUPS[i].lambda;
      return (z + d * nextN) / (1 + d);
    }),
  };
}

const CRITICAL_T = 647.096;
const CRITICAL_P = 22.064;
const SAT_COEFFICIENTS = [-7.85951783, 1.84408259, -11.7866497, 22.6807411, -15.9618719, 1.80122502];
const SAT_EXPONENTS = [1, 1.5, 3, 3.5, 4, 7.5];

/** IAPWS SR1-86(1992) Eq. 1 saturation pressure: input C, output MPa.
 * Published coefficients from https://iapws.org/technical-guidance/release/Supp-sat
 * Valid only for saturated pure water between triple and critical points.
 */
export function saturationPressure(tempC) {
  const t = tempC + 273.15;
  if (!Number.isFinite(t) || t < 273.16 || t > CRITICAL_T) {
    throw new RangeError('Water saturation temperature must be 0.01 to 373.946 C');
  }
  const tau = 1 - t / CRITICAL_T;
  const sum = SAT_COEFFICIENTS.reduce((v, a, i) => v + a * tau ** SAT_EXPONENTS[i], 0);
  return CRITICAL_P * Math.exp(CRITICAL_T / t * sum);
}

/** Monotone bisection inverse of the IAPWS saturation-pressure equation. */
export function saturationTemperature(pressureMPa) {
  if (!Number.isFinite(pressureMPa) || pressureMPa < 0.000611657 || pressureMPa > CRITICAL_P) {
    throw new RangeError('Saturation pressure outside triple-to-critical-point range');
  }
  let lo = 0.01;
  let hi = CRITICAL_T - 273.15;
  for (let i = 0; i < 58; i++) {
    const mid = (lo + hi) / 2;
    if (saturationPressure(mid) < pressureMPa) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Deliberately reduced-order enthalpy closure, NOT IF97. MJ/kg, zero at 0 C.
// Liquid quadratic fitted to NIST saturated liquid enthalpies at 100 and 280 C.
// Latent heat uses the Watson 0.38 power law anchored at 100 C, 2.2564 MJ/kg.
// These fits provide approximately percent-level closure around nominal conditions;
// they are not suitable for near-critical, compressed-liquid or severe-accident work.
export const LIQUID_A = 0.004066255555555556;
export const LIQUID_B = 0.0000012544444444444444;
export function liquidEnthalpy(tempC) {
  if (!Number.isFinite(tempC) || tempC < 0 || tempC >= 373.946) throw new RangeError('Enthalpy temperature outside liquid model domain');
  return LIQUID_A * tempC + LIQUID_B * tempC * tempC;
}
export function vaporEnthalpy(tempC) {
  const liquid = liquidEnthalpy(tempC);
  const ratio = (1 - (tempC + 273.15) / CRITICAL_T) / (1 - 373.15 / CRITICAL_T);
  return liquid + 2.2564 * ratio ** 0.38;
}

export function steamStoredEnergy(tempC, massKg, metalCapacity) {
  return metalCapacity * tempC + massKg * liquidEnthalpy(tempC);
}

/** Exact inverse for E=Cmetal*T + M*(a*T+b*T²), cancellation-safe positive root. */
export function steamTemperatureFromEnergy(energyMJ, massKg, metalCapacity) {
  const a = massKg * LIQUID_B;
  const b = metalCapacity + massKg * LIQUID_A;
  if (![energyMJ, massKg, metalCapacity].every(Number.isFinite) || massKg <= 0 || energyMJ <= 0 || metalCapacity <= 0) {
    throw new RangeError('Steam inventory energy outside model domain');
  }
  return 2 * energyMJ / (b + Math.sqrt(b * b + 4 * a * energyMJ));
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const relax = (value, target, dt, tau) => target + (value - target) * Math.exp(-dt / tau);
