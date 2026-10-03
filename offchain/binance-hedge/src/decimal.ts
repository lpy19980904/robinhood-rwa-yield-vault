export const DECIMAL_SCALE_DIGITS = 12;
export const DECIMAL_SCALE = 10n ** BigInt(DECIMAL_SCALE_DIGITS);

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;

export function parseDecimal(value: string, label: string): bigint {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a plain decimal string with at most 12 fractional digits`);
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(DECIMAL_SCALE_DIGITS, "0") || "0");
  return negative ? -units : units;
}

export function formatDecimal(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / DECIMAL_SCALE;
  const fraction = (absolute % DECIMAL_SCALE).toString().padStart(DECIMAL_SCALE_DIGITS, "0").replace(/0+$/, "");
  const formatted = fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${formatted}` : formatted;
}

export function multiplyDecimal(left: bigint, right: bigint): bigint {
  return (left * right) / DECIMAL_SCALE;
}

export function divideDecimal(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  return (numerator * DECIMAL_SCALE) / denominator;
}

export function floorToStep(quantity: bigint, step: bigint): bigint {
  if (quantity < 0n || step <= 0n) throw new Error("Quantity must be nonnegative and step must be positive");
  return (quantity / step) * step;
}

export function isMultipleOfStep(quantity: bigint, step: bigint): boolean {
  return step > 0n && quantity % step === 0n;
}
