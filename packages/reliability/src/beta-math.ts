/**
 * @fileoverview Beta distribution helpers for the reliability score.
 * The scoring policy uses the inverse cumulative distribution function
 * for its lower credible bound. Read docs/reliability-math.md.
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural logarithm of the gamma function for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new Error('logGamma needs a finite positive input');
  if (x < 0.5) {
    // Reflection keeps precision for small inputs.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < LANCZOS.length; index++) {
    sum += (LANCZOS[index] ?? 0) / (z + index + 1);
  }
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-15) return result;
  }
  return result;
}

function assertShape(alpha: number, beta: number): void {
  if (!(alpha > 0) || !(beta > 0) || !Number.isFinite(alpha) || !Number.isFinite(beta)) {
    throw new Error('Beta parameters must be finite and positive');
  }
}

/** Regularized incomplete beta function I_x(alpha, beta), the Beta CDF at x. */
export function betaCdf(x: number, alpha: number, beta: number): number {
  assertShape(alpha, beta);
  if (Number.isNaN(x)) throw new Error('x must be a number');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront = logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta) +
    alpha * Math.log(x) + beta * Math.log1p(-x);
  const front = Math.exp(logFront);
  if (x < (alpha + 1) / (alpha + beta + 2)) {
    return front * betaContinuedFraction(x, alpha, beta) / alpha;
  }
  return 1 - front * betaContinuedFraction(1 - x, beta, alpha) / beta;
}

/**
 * Inverse Beta CDF. Returns x with I_x(alpha, beta) = p.
 * Bisection keeps the result inside [0, 1] for every valid shape.
 */
export function betaQuantile(p: number, alpha: number, beta: number): number {
  assertShape(alpha, beta);
  if (!(p >= 0 && p <= 1)) throw new Error('p must be between zero and one');
  if (p === 0) return 0;
  if (p === 1) return 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (betaCdf(mid, alpha, beta) < p) low = mid;
    else high = mid;
    if (high - low < 1e-15) break;
  }
  return (low + high) / 2;
}
