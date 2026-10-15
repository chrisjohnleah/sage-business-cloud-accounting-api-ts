/**
 * Turns a Sage amount into whole pence (or cents) without float arithmetic.
 *
 * Accepts the plain numbers and numeric strings Sage sends: `120`, `"120.00"`,
 * `"0.5"`, `-3.2`. It throws a `RangeError` for anything it would have to guess:
 * a thousands separator (`"1,234.56"`), a third decimal place that is not zero
 * (`"0.125"`), exponent notation, and values beyond `Number.MAX_SAFE_INTEGER` pence.
 */
export function toPence(amount: number | string): number {
  if (typeof amount === 'number' && !Number.isFinite(amount)) throw new RangeError(`Not a Sage amount: ${amount}`)
  const text = (typeof amount === 'number' ? String(amount) : amount).trim()
  const match = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(text)
  if (!match) throw new RangeError(`Not a Sage amount: ${JSON.stringify(text.slice(0, 40))}`)
  const [, sign, whole = '', fraction1, fraction2] = match
  const fraction = fraction1 ?? fraction2 ?? ''
  if (/[1-9]/.test(fraction.slice(2))) throw new RangeError(`Amount has more than two decimal places: ${text}`)
  const pence = Number(`${whole || '0'}${fraction.slice(0, 2).padEnd(2, '0')}`)
  if (!Number.isSafeInteger(pence)) throw new RangeError(`Amount is too large: ${text.slice(0, 40)}`)
  return sign === '-' && pence !== 0 ? -pence : pence
}
