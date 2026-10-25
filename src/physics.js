// SPDX-License-Identifier: Apache-2.0
// Original implementations of public mathematical correlations; no third-party code.
import { if97SaturationPressure, if97Region1, if97Region2 } from './water-properties.js';

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
export function stepKinetics(n, precursors, rhoPcm, dt, {
  groups = DELAYED_GROUPS, generationTime = GENERATION_TIME, source = 0,
} = {}) {
  if (!Number.isFinite(n) || n < 0 || !Array.isArray(precursors)
      || !Array.isArray(groups) || groups.length < 1 || groups.length > 16
      || Array.from(groups).some(g => !g || !Number.isFinite(g.beta) || g.beta <= 0
        || !Number.isFinite(g.lambda) || g.lambda <= 0)
      || precursors.length !== groups.length || Array.from(precursors).some(x => !Number.isFinite(x) || x < 0)
      || !Number.isFinite(generationTime) || generationTime <= 0
      || !Number.isFinite(source) || source < 0
      || !Number.isFinite(rhoPcm) || !Number.isFinite(dt) || dt <= 0) {
    throw new RangeError('Invalid point-kinetics state or time step');
  }
  let numerator = n + dt * source;
  let denominator = 1 - dt * rhoPcm * 1e-5 / generationTime;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const factor = dt * g.beta / (generationTime * (1 + dt * g.lambda));
    numerator += factor * precursors[i];
    denominator += factor;
  }
  if (!Number.isFinite(denominator) || denominator <= 0) throw new RangeError('Point-kinetics time step outside positivity domain');
  const nextN = numerator / denominator;
  if (!Number.isFinite(nextN)) throw new RangeError('Point-kinetics result outside finite domain');
  return {
    n: nextN,
    precursors: precursors.map((z, i) => {
      const d = dt * groups[i].lambda;
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

// Production saturated-water enthalpies, MJ/kg, evaluated from IF97 regions 1/2.
// A 0.25 C cache makes property access O(1). Linear interpolation is also used
// by the energy inverse, so interpolation does not introduce an accounting leak.
// Saturated-liquid enthalpy remains an approximation for compressed feedwater.
export const ENTHALPY_TABLE_STEP = 0.25;
export const ENTHALPY_MAX_TEMP = 350;
const ENTHALPY_TABLE = Array.from({ length: ENTHALPY_MAX_TEMP / ENTHALPY_TABLE_STEP + 1 }, (_, i) => {
  const temperatureK = i * ENTHALPY_TABLE_STEP + 273.15;
  const pressureMPa = if97SaturationPressure(temperatureK);
  return [if97Region1(temperatureK, pressureMPa).h / 1000,
    if97Region2(temperatureK, pressureMPa).h / 1000];
});
function enthalpy(tempC, phase) {
  if (!Number.isFinite(tempC) || tempC < 0 || tempC > ENTHALPY_MAX_TEMP) {
    throw new RangeError('Enthalpy temperature must be 0..350 C');
  }
  const coordinate = tempC / ENTHALPY_TABLE_STEP;
  const i = Math.min(Math.floor(coordinate), ENTHALPY_TABLE.length - 2);
  return ENTHALPY_TABLE[i][phase]
    + (coordinate - i) * (ENTHALPY_TABLE[i + 1][phase] - ENTHALPY_TABLE[i][phase]);
}
export const liquidEnthalpy = tempC => enthalpy(tempC, 0);
export const vaporEnthalpy = tempC => enthalpy(tempC, 1);

export function steamStoredEnergy(tempC, massKg, metalCapacity) {
  return metalCapacity * tempC + massKg * liquidEnthalpy(tempC);
}

/** Exact inverse of the piecewise-linear storage E=Cmetal*T+M*hL(T). */
export function steamTemperatureFromEnergy(energyMJ, massKg, metalCapacity) {
  if (![energyMJ, massKg, metalCapacity].every(Number.isFinite) || massKg <= 0 || energyMJ <= 0 || metalCapacity <= 0) {
    throw new RangeError('Steam inventory energy outside model domain');
  }
  const energyAt = i => metalCapacity * i * ENTHALPY_TABLE_STEP + massKg * ENTHALPY_TABLE[i][0];
  let lo = 0;
  let hi = ENTHALPY_TABLE.length - 1;
  if (energyMJ < energyAt(lo) || energyMJ > energyAt(hi)) throw new RangeError('Steam energy implies temperature outside 0..350 C');
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (energyAt(mid) <= energyMJ) lo = mid;
    else hi = mid;
  }
  const lower = energyAt(lo);
  return ENTHALPY_TABLE_STEP * (lo + (energyMJ - lower) / (energyAt(hi) - lower));
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const relax = (value, target, dt, tau) => target + (value - target) * Math.exp(-dt / tau);
