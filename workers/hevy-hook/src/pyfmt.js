// Python-compatible number formatting / rounding.
//
// Python's round(x, n) and f"{x:.nf}" round the EXACT binary value of the
// float, half-to-even on exact ties.  JS Math.round / toFixed differ on ties
// (toFixed picks the larger n), so the tools/*.py numbers would drift by 0.1
// on values like 0.25.  toFixed(100) yields the exact decimal expansion for
// every magnitude we deal with (|x| between ~1e-15 and 1e21), and the
// half-even decision is made on that string.

function exactDigits(absX) {
  const s = absX.toFixed(100);
  const dot = s.indexOf(".");
  return { int: s.slice(0, dot), frac: s.slice(dot + 1) };
}

function incDecimalString(digits) {
  // "1299" -> "1300", "999" -> "1000"
  const arr = digits.split("");
  let i = arr.length - 1;
  while (i >= 0) {
    if (arr[i] === "9") {
      arr[i] = "0";
      i -= 1;
    } else {
      arr[i] = String(Number(arr[i]) + 1);
      return arr.join("");
    }
  }
  return "1" + arr.join("");
}

/** Python f"{x:.{n}f}" (no thousands separator). */
export function pyFixed(x, n) {
  x = Number(x);
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  const { int, frac } = exactDigits(Math.abs(x));
  const keep = frac.slice(0, n);
  const rest = frac.slice(n);
  let roundUp = false;
  if (rest.length && rest[0] > "5") roundUp = true;
  else if (rest[0] === "5") {
    if (/[1-9]/.test(rest.slice(1))) roundUp = true;
    else {
      // exact tie -> half to even on the last kept digit
      const last = n > 0 ? keep[n - 1] : int[int.length - 1];
      roundUp = Number(last) % 2 === 1;
    }
  }
  let all = int + keep;
  if (roundUp) all = incDecimalString(all);
  const intPart = n > 0 ? all.slice(0, all.length - n) : all;
  const fracPart = n > 0 ? all.slice(all.length - n) : "";
  const body = (intPart.replace(/^0+(?=\d)/, "") || "0") + (n > 0 ? "." + fracPart : "");
  return (neg ? "-" : "") + body;
}

/** Python round(x, n) -> Number (null passes through like r1/r2 in build_strength.py). */
export function pyRound(x, n) {
  if (x === null || x === undefined) return null;
  const v = Number(pyFixed(x, n));
  return Object.is(v, -0) ? 0 : v;
}

export const r1 = (x) => pyRound(x, 1);
export const r2 = (x) => pyRound(x, 2);

/** Python f"{x:,.0f}". */
export function pyThousands0(x) {
  const s = pyFixed(x, 0);
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped;
}
