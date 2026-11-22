// Fees are calculated in BASIS POINTS (1 bp = 0.01%), not percentages,
// specifically so the math stays integer-only. Multiplying amountPaise
// (an integer) by a percentage like 0.5 would involve a float, which is
// exactly the kind of rounding-error risk this whole project exists to
// avoid. Basis points let us do (amountPaise * bp) / 10000 - one integer
// multiply, one integer divide, only rounding ONCE at the very end.
const FEE_TIERS = [
  { maxAmountPaise: 100000, feeBasisPoints: 50 },   // up to ₹1,000: 0.50%
  { maxAmountPaise: 1000000, feeBasisPoints: 30 },  // up to ₹10,000: 0.30%
  { maxAmountPaise: Infinity, feeBasisPoints: 10 }, // above ₹10,000: 0.10%
];

const MIN_FEE_PAISE = 100; // ₹1 minimum, so tiny transfers don't round to a 0 fee

function calculateFee(amountPaise) {
  const tier = FEE_TIERS.find((t) => amountPaise <= t.maxAmountPaise);
  const rawFee = Math.round((amountPaise * tier.feeBasisPoints) / 10000);
  return Math.max(rawFee, MIN_FEE_PAISE);
}

module.exports = { calculateFee, FEE_TIERS, MIN_FEE_PAISE };