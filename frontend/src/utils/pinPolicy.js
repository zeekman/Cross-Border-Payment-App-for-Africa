/**
 * Client-side mirror of the backend weak-PIN rules (BE-209).
 * Returns a reason ('repeated' | 'sequential' | 'common' | 'personal') or null.
 */
const COMMON_PINS = new Set([
  '1212', '2580', '0852', '1313', '2020', '1010', '6969', '1122', '1221', '2112', '2211',
  '1004', '4321', '1342', '2323', '0101', '1414', '1515', '5683', '0007', '1112', '1110',
  '112233', '121212', '123123', '123321', '159753', '147258', '258258', '696969', '101010',
  '131313', '232323', '520131', '789456', '456789', '112211', '12321', '12312', '11223',
]);

const isRun = (pin, step) =>
  [...pin].every((d, i) => i === 0 || Number(d) === Number(pin[i - 1]) + step);

export function getWeakPinReason(pin) {
  if (!/^\d{4,6}$/.test(pin)) return null;
  if (/^(\d)\1+$/.test(pin)) return 'repeated';
  if (isRun(pin, 1) || isRun(pin, -1)) return 'sequential';
  if (COMMON_PINS.has(pin)) return 'common';
  // The date of birth isn't available client-side, so block plausible birth years.
  if (pin.length === 4) {
    const year = Number(pin);
    if (year >= 1920 && year <= new Date().getFullYear()) return 'personal';
  }
  return null;
}
