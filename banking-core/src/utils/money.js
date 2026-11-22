// Small helpers so the rest of the codebase never touches floats for money.
// Rupees are only for display - every calculation happens in paise (integers).

function rupeesToPaise(rupees) {
  return Math.round(rupees * 100);
}

function paiseToRupees(paise) {
  return Number(paise) / 100;
}

module.exports = { rupeesToPaise, paiseToRupees };
