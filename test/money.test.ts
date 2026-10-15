import { describe, expect, it } from 'vitest'
import { toPence } from '../src/index.js'

describe('toPence', () => {
  it('reads numeric strings and numbers', () => {
    expect(toPence('120.00')).toBe(12000)
    expect(toPence(120)).toBe(12000)
    expect(toPence('0.5')).toBe(50)
    expect(toPence('367.09')).toBe(36709)
    expect(toPence(367.09)).toBe(36709)
    expect(toPence('.5')).toBe(50)
    expect(toPence(' 7 ')).toBe(700)
  })

  it('does not suffer float error', () => {
    expect(toPence(1.1)).toBe(110)
    expect(toPence(19.99)).toBe(1999)
    expect(() => toPence(1.005)).toThrow(RangeError)
  })

  it('handles negatives and does not return negative zero', () => {
    expect(toPence('-3.20')).toBe(-320)
    expect(toPence(-0.07)).toBe(-7)
    expect(Object.is(toPence('-0.00'), 0)).toBe(true)
  })

  it('accepts trailing zeros past the second decimal place', () => {
    expect(toPence('12.500')).toBe(1250)
  })

  it('refuses what it would have to guess', () => {
    expect(() => toPence('1,234.56')).toThrow(RangeError)
    expect(() => toPence('0.125')).toThrow(/more than two decimal places/)
    expect(() => toPence(0.125)).toThrow(RangeError)
    expect(() => toPence('')).toThrow(RangeError)
    expect(() => toPence('12.')).toThrow(RangeError)
    expect(() => toPence('abc')).toThrow(RangeError)
    expect(() => toPence(Number.NaN)).toThrow(RangeError)
    expect(() => toPence(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => toPence(1e-7)).toThrow(RangeError)
    expect(() => toPence('90071992547409.93')).toThrow(/too large/)
  })
})
