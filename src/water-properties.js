// SPDX-License-Identifier: Apache-2.0
// Original implementation of IAPWS R7-97(2012), Eqs. 7, 15-17 and 30.
// Coefficients: https://iapws.org/technical-guidance/release/IF97-Rev.download
// Only regions 1, 2 and saturation pressure are implemented. No region 3/5,
// metastable-vapor formulation, transport properties or two-phase mixture EOS.

export const WATER_GAS_CONSTANT = 0.461526; // kJ/(kg K), release Eq. 1
const R1 = [ // [I, J, n], release Table 2
  [0,-2,.14632971213167], [0,-1,-.84548187169114], [0,0,-3.7563603672040],
  [0,1,3.3855169168385], [0,2,-.95791963387872], [0,3,.15772038513228],
  [0,4,-.016616417199501], [0,5,.00081214629983568], [1,-9,.00028319080123804],
  [1,-7,-.00060706301565874], [1,-1,-.018990068218419], [1,0,-.032529748770505],
  [1,1,-.021841717175414], [1,3,-.000052838357969930], [2,-3,-.00047184321073267],
  [2,0,-.00030001780793026], [2,1,.000047661393906987], [2,3,-.0000044141845330846],
  [2,17,-.72694996297594e-15], [3,-4,-.31679644845054e-4], [3,0,-.28270797985312e-5],
  [3,6,-.85205128120103e-9], [4,-5,-.22425281908000e-5], [4,-2,-.65171222895601e-6],
  [4,10,-.14341729937924e-12], [5,-8,-.40516996860117e-6], [8,-11,-.12734301741641e-8],
  [8,-6,-.17424871230634e-9], [21,-29,-.68762131295531e-18], [23,-31,.14478307828521e-19],
  [29,-38,.26335781662795e-22], [30,-39,-.11947622640071e-22],
  [31,-40,.18228094581404e-23], [32,-41,-.93537087292458e-25],
];
const R2_IDEAL = [ // [J, n], release Table 10, stable-vapor coefficients
  [0,-9.6927686500217], [1,10.086655968018], [-5,-.0056087911283020],
  [-4,.071452738081455], [-3,-.40710498223928], [-2,1.4240819171444],
  [-1,-4.3839511319450], [2,-.28408632460772], [3,.021268463753307],
];
const R2_RESIDUAL = [ // [I, J, n], release Table 11
  [1,0,-.17731742473213e-2], [1,1,-.17834862292358e-1], [1,2,-.45996013696365e-1],
  [1,3,-.57581259083432e-1], [1,6,-.50325278727930e-1], [2,1,-.33032641670203e-4],
  [2,2,-.18948987516315e-3], [2,4,-.39392777243355e-2], [2,7,-.43797295650573e-1],
  [2,36,-.26674547914087e-4], [3,0,.20481737692309e-7], [3,1,.43870667284435e-6],
  [3,3,-.32277677238570e-4], [3,6,-.15033924542148e-2], [3,35,-.40668253562649e-1],
  [4,1,-.78847309559367e-9], [4,2,.12790717852285e-7], [4,3,.48225372718507e-6],
  [5,7,.22922076337661e-5], [6,3,-.16714766451061e-10], [6,16,-.21171472321355e-2],
  [6,35,-.23895741934104e2], [7,0,-.59059564324270e-17], [7,11,-.12621808899101e-5],
  [7,25,-.38946842435739e-1], [8,8,.11256211360459e-10], [8,36,-.82311340897998e1],
  [9,13,.19809712802088e-7], [10,4,.10406965210174e-18], [10,10,-.10234747095929e-12],
  [10,14,-.10018179379511e-8], [16,29,-.80882908646985e-10], [16,50,.10693031879409],
  [18,57,-.33662250574171], [20,20,.89185845355421e-24], [20,35,.30629316876232e-12],
  [20,48,-.42002467698208e-5], [21,21,-.59056029685639e-25], [22,53,.37826947613457e-5],
  [23,39,-.12768608934681e-14], [24,26,.73087610595061e-28],
  [24,40,.55414715350778e-16], [24,58,-.94369707241210e-6],
];
const SAT = [ // release Table 34, indices 1..10
  0, .11670521452767e4, -.72421316703206e6, -.17073846940092e2,
  .12020824702470e5, -.32325550322333e7, .14915108613530e2,
  -.48232657361591e4, .40511340542057e6, -.23855557567849, .65017534844798e3,
];

/** IF97 Eq. 30: temperature K -> saturation pressure MPa. */
export function if97SaturationPressure(temperatureK) {
  if (!Number.isFinite(temperatureK) || temperatureK < 273.15 || temperatureK > 647.096) {
    throw new RangeError('IF97 saturation temperature must be 273.15..647.096 K');
  }
  const theta = temperatureK + SAT[9] / (temperatureK - SAT[10]);
  const a = theta * theta + SAT[1] * theta + SAT[2];
  const b = SAT[3] * theta * theta + SAT[4] * theta + SAT[5];
  const c = SAT[6] * theta * theta + SAT[7] * theta + SAT[8];
  return (2 * c / (-b + Math.sqrt(b * b - 4 * a * c))) ** 4;
}

function properties(temperatureK, pressureMPa, pi, tau, gamma, gammaPi, gammaTau, gammaTauTau) {
  const rt = WATER_GAS_CONSTANT * temperatureK;
  return {
    temperatureK, pressureMPa,
    v: pi * gammaPi * rt / (pressureMPa * 1000), // m³/kg
    h: rt * tau * gammaTau, // kJ/kg
    u: rt * (tau * gammaTau - pi * gammaPi), // kJ/kg
    s: WATER_GAS_CONSTANT * (tau * gammaTau - gamma), // kJ/(kg K)
    cp: -WATER_GAS_CONSTANT * tau * tau * gammaTauTau, // kJ/(kg K)
  };
}

/** Stable liquid, IF97 region 1. Input K and MPa; output units documented above. */
export function if97Region1(temperatureK, pressureMPa) {
  if (!Number.isFinite(temperatureK) || temperatureK < 273.15 || temperatureK > 623.15
      || !Number.isFinite(pressureMPa) || pressureMPa > 100
      || pressureMPa < if97SaturationPressure(temperatureK) * (1 - 1e-12)) {
    throw new RangeError('State outside IF97 region 1');
  }
  const pi = pressureMPa / 16.53;
  const tau = 1386 / temperatureK;
  const x = 7.1 - pi;
  const y = tau - 1.222;
  let gamma = 0, gammaPi = 0, gammaTau = 0, gammaTauTau = 0;
  for (const [i, j, n] of R1) {
    gamma += n * x ** i * y ** j;
    if (i) gammaPi -= n * i * x ** (i - 1) * y ** j;
    if (j) gammaTau += n * x ** i * j * y ** (j - 1);
    if (j && j !== 1) gammaTauTau += n * x ** i * j * (j - 1) * y ** (j - 2);
  }
  return properties(temperatureK, pressureMPa, pi, tau, gamma, gammaPi, gammaTau, gammaTauTau);
}

/** Stable vapor, IF97 region 2 (not the metastable-vapor extension). */
export function if97Region2(temperatureK, pressureMPa) {
  if (!Number.isFinite(temperatureK) || temperatureK < 273.15 || temperatureK > 1073.15
      || !Number.isFinite(pressureMPa) || pressureMPa <= 0) {
    throw new RangeError('State outside IF97 region 2');
  }
  const maximumPressure = temperatureK <= 623.15 ? if97SaturationPressure(temperatureK)
    : temperatureK < 863.15
      ? 348.05185628969 - 1.1671859879975 * temperatureK + .0010192970039326 * temperatureK ** 2
      : 100;
  if (pressureMPa > maximumPressure * (1 + 1e-12)) throw new RangeError('State outside IF97 region 2');
  const pi = pressureMPa;
  const tau = 540 / temperatureK;
  const y = tau - .5;
  let gamma = Math.log(pi), gammaPi = 1 / pi, gammaTau = 0, gammaTauTau = 0;
  for (const [j, n] of R2_IDEAL) {
    gamma += n * tau ** j;
    if (j) gammaTau += n * j * tau ** (j - 1);
    if (j && j !== 1) gammaTauTau += n * j * (j - 1) * tau ** (j - 2);
  }
  for (const [i, j, n] of R2_RESIDUAL) {
    gamma += n * pi ** i * y ** j;
    gammaPi += n * i * pi ** (i - 1) * y ** j;
    if (j) gammaTau += n * pi ** i * j * y ** (j - 1);
    if (j && j !== 1) gammaTauTau += n * pi ** i * j * (j - 1) * y ** (j - 2);
  }
  return properties(temperatureK, pressureMPa, pi, tau, gamma, gammaPi, gammaTau, gammaTauTau);
}
