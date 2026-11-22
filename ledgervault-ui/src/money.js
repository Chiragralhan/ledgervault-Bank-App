// Turns what a person types ("500", "1,250.5") into integer paise, WITHOUT
// using floating-point maths (0.1 + 0.2 problems). Returns null if invalid.
export function rupeesToPaise(text) {
  const cleaned = String(text).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0'), 10);
}