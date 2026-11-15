// Double-precision normal distribution helpers and numerical integration.
// The erfc Chebyshev coefficients are from Numerical Recipes, 3rd edition
// (erfccheb), which is accurate to roughly machine precision for the range
// needed by the sequential boundary solver.

const ERFC_COEFFICIENTS = [
  -1.3026537197817094, 6.4196979235649026e-1,
  1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4,
  3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
  9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
  -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17
];

export function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let index = ERFC_COEFFICIENTS.length - 1; index > 0; index -= 1) {
    const previous = d;
    d = ty * d - dd + ERFC_COEFFICIENTS[index];
    dd = previous;
  }
  const answer = t * Math.exp(-z * z + 0.5 *
    (ERFC_COEFFICIENTS[0] + ty * d) - dd);
  return x >= 0 ? answer : 2 - answer;
}

export function normalCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

export function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Peter Acklam's inverse normal approximation, followed by one Newton step
// against normalCdf. Relative accuracy after the step is close to machine
// precision for the probabilities used in this project.
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error('概率必须严格位于 0 与 1 之间');
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00
  ];
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // One Newton correction using the stable CDF evaluation.
  const error = normalCdf(x) - p;
  const slope = normalPdf(x);
  if (slope > 0) x -= error / slope;
  return x;
}

const LEGENDRE_CACHE = new Map();

// Gauss-Legendre nodes and weights on [-1, 1]. Cached because the same
// order is reused for every look and for the refinement comparison.
export function gaussLegendre(order) {
  const cached = LEGENDRE_CACHE.get(order);
  if (cached) return cached;
  if (!Number.isSafeInteger(order) || order < 2) throw new Error('积分阶数必须是至少为 2 的整数');
  const nodes = new Float64Array(order);
  const weights = new Float64Array(order);
  for (let index = 0; index < order; index += 1) {
    let x = Math.cos(Math.PI * (index + 0.75) / (order + 0.5));
    let derivative = 0;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      let previous = 1;
      let current = x;
      for (let degree = 2; degree <= order; degree += 1) {
        const next = ((2 * degree - 1) * x * current - (degree - 1) * previous) / degree;
        previous = current;
        current = next;
      }
      derivative = order * (x * current - previous) / (x * x - 1);
      const step = current / derivative;
      x -= step;
      if (Math.abs(step) < 1e-15) break;
    }
    // Re-evaluate the derivative at the converged root.
    let previous = 1;
    let current = x;
    for (let degree = 2; degree <= order; degree += 1) {
      const next = ((2 * degree - 1) * x * current - (degree - 1) * previous) / degree;
      previous = current;
      current = next;
    }
    derivative = order * (x * current - previous) / (x * x - 1);
    nodes[index] = x;
    weights[index] = 2 / ((1 - x * x) * derivative * derivative);
  }
  const result = { nodes, weights };
  LEGENDRE_CACHE.set(order, result);
  return result;
}

// Deterministic PRNG used only by the simulation/demo paths.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Wilson score interval for a binomial proportion; used to report the
// Monte Carlo uncertainty of the type-I error estimate.
export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (trials <= 0) return { low: 0, high: 1, center: 0 };
  const p = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = (p + z * z / (2 * trials)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) /
    denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half), center };
}

// --- Student t ---------------------------------------------------------
// The two-sample statistic divides by an estimated variance, so its tail is
// heavier than the normal one. The finite-sample correction used by the
// sequential design relies on these quantiles.

function logGamma(x) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ];
  let y = x;
  let temporary = x + 5.5;
  temporary -= (x + 0.5) * Math.log(temporary);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) {
    y += 1;
    series += coefficient / y;
  }
  return -temporary + Math.log(2.5066282746310005 * series / x);
}

function incompleteBetaFraction(a, b, x) {
  const tiny = 1e-300;
  const epsilon = 3e-16;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= 400; iteration += 1) {
    const doubled = 2 * iteration;
    let numerator = iteration * (b - iteration) * x / ((qam + doubled) * (a + doubled));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    numerator = -(a + iteration) * (qab + iteration) * x /
      ((a + doubled) * (qap + doubled));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) return result;
  }
  throw new Error('不完全 beta 函数未收敛');
}

function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * incompleteBetaFraction(a, b, x) / a
    : 1 - front * incompleteBetaFraction(b, a, 1 - x) / b;
}

export function studentTCdf(t, degreesOfFreedom) {
  if (!(degreesOfFreedom > 0)) throw new Error('自由度必须大于 0');
  const x = degreesOfFreedom / (degreesOfFreedom + t * t);
  const tail = 0.5 * incompleteBeta(degreesOfFreedom / 2, 0.5, x);
  return t >= 0 ? 1 - tail : tail;
}

export function studentTQuantile(p, degreesOfFreedom) {
  if (!(p > 0 && p < 1)) throw new Error('概率必须严格位于 0 与 1 之间');
  if (!(degreesOfFreedom > 0)) throw new Error('自由度必须大于 0');
  let low = -1e4;
  let high = 1e4;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < p) low = middle;
    else high = middle;
    if (high - low < 1e-12) break;
  }
  return (low + high) / 2;
}
