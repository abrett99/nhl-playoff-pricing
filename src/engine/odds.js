// ============================================================================
// ODDS UTILITIES
// ============================================================================
// American ↔ Decimal ↔ Probability conversions, de-vigging, and Kelly sizing.
// Every number that touches a betting decision flows through these.
// ============================================================================

/** American odds → implied probability (with vig) */
export function americanToProb(american) {
  const o = Number(american);
  if (!Number.isFinite(o)) throw new Error(`Invalid American odds: ${american}`);
  if (o === 0) throw new Error('American odds cannot be 0');
  return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
}

/** American → decimal */
export function americanToDecimal(american) {
  const o = Number(american);
  if (!Number.isFinite(o)) throw new Error(`Invalid American odds: ${american}`);
  return o < 0 ? 1 + (100 / -o) : 1 + (o / 100);
}

/** Decimal → American */
export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) throw new Error(`Invalid decimal odds: ${decimal}`);
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Probability → American odds (fair, no vig) */
export function probToAmerican(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(`Invalid probability: ${prob}`);
  }
  return p >= 0.5
    ? Math.round(-100 * p / (1 - p))
    : Math.round(100 * (1 - p) / p);
}

/** Probability → decimal (fair, no vig) */
export function probToDecimal(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(`Invalid probability: ${prob}`);
  }
  return 1 / p;
}

/**
 * De-vig two-way American odds using the POWER method.
 * Better than multiplicative for favorite-longshot bias (especially Pinnacle).
 *
 * Finds k such that prob(a)^k + prob(b)^k = 1.
 *
 * Returns { aProb, bProb, vig, method: 'power' }
 */
export function devigPower(americanA, americanB) {
  const pA = americanToProb(americanA);
  const pB = americanToProb(americanB);
  const total = pA + pB;
  const vig = total - 1;

  if (vig < 0) {
    // Arbitrage — no de-vig needed, but flag it
    return { aProb: pA, bProb: pB, vig, method: 'power', arbitrage: true };
  }
  if (vig < 0.001) {
    return { aProb: pA, bProb: pB, vig, method: 'power' };
  }

  // Binary search for k in [0.5, 2.0]
  let lo = 0.5, hi = 2.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = Math.pow(pA, mid) + Math.pow(pB, mid);
    if (sum > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;

  const aProbFair = Math.pow(pA, k);
  const bProbFair = Math.pow(pB, k);

  return { aProb: aProbFair, bProb: bProbFair, vig, method: 'power' };
}

/**
 * De-vig two-way odds using the MULTIPLICATIVE method.
 * Simpler but worse for sharp lines; fine for recreational books.
 */
export function devigMultiplicative(americanA, americanB) {
  const pA = americanToProb(americanA);
  const pB = americanToProb(americanB);
  const total = pA + pB;
  return {
    aProb: pA / total,
    bProb: pB / total,
    vig: total - 1,
    method: 'multiplicative',
  };
}

/**
 * De-vig an n-way market (e.g. series total exactly 4/5/6/7 = 8 outcomes)
 * using multiplicative normalization.
 */
export function devigNWay(americanArray) {
  const probs = americanArray.map(americanToProb);
  const total = probs.reduce((s, p) => s + p, 0);
  return {
    probs: probs.map(p => p / total),
    vig: total - 1,
    method: 'multiplicative',
  };
}

/**
 * Calculate edge (expected value) of a bet.
 * @param {number} modelProb - Your fair probability
 * @param {number} american - Book's offered American odds
 * @returns {number} Edge as decimal (e.g. 0.082 = 8.2% edge)
 */
export function edge(modelProb, american) {
  const decimal = americanToDecimal(american);
  return modelProb * decimal - 1;
}

/**
 * Kelly stake fraction of bankroll.
 * Uses fractional Kelly by default (0.25 = quarter Kelly) for safety.
 */
export function kellyStake(modelProb, american, bankroll, fraction = 0.25) {
  const b = americanToDecimal(american) - 1;
  const p = modelProb;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  if (kelly <= 0) return { stake: 0, edge: 0, kellyPct: 0 };

  const fractional = kelly * fraction;
  return {
    stake: Math.round(bankroll * fractional * 100) / 100,
    edge: edge(modelProb, american),
    kellyPct: kelly,
    fractionalKellyPct: fractional,
  };
}
