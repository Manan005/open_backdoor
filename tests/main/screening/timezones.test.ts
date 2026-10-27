import { describe, expect, it } from 'vitest'
import { countryFromText } from '../../../src/main/screening/timezones'

describe('countryFromText', () => {
  it('maps location strings to ISO codes', () => {
    expect(countryFromText('San Francisco, CA, USA')).toBe('US')
    expect(countryFromText('Bengaluru, Karnataka, India')).toBe('IN')
    expect(countryFromText('London, England, United Kingdom')).toBe('GB')
    expect(countryFromText('Waterloo, ON, Canada')).toBe('CA')
    expect(countryFromText('Cologne, NRW, Germany')).toBe('DE')
    expect(countryFromText('Paris, France')).toBe('FR')
    expect(countryFromText('Singapore')).toBe('SG')
    expect(countryFromText('Dubai, United Arab Emirates')).toBe('AE')
    expect(countryFromText('Sydney, Australia')).toBe('AU')
    expect(countryFromText('Amsterdam, Netherlands')).toBe('NL')
    expect(countryFromText('Tel Aviv, Israel')).toBe('IL')
    expect(countryFromText('São Paulo, Brazil')).toBe('BR')
  })

  it('maps common cities without a country', () => {
    expect(countryFromText('Berlin')).toBe('DE')
    expect(countryFromText('Mumbai')).toBe('IN')
    expect(countryFromText('New York')).toBe('US')
    expect(countryFromText('Toronto')).toBe('CA')
  })

  it('returns null when nothing matches', () => {
    expect(countryFromText('Remote')).toBeNull()
    expect(countryFromText('')).toBeNull()
    expect(countryFromText('Narnia')).toBeNull()
  })

  it('does not match short codes inside other words', () => {
    expect(countryFromText('Indiana')).toBeNull()
    expect(countryFromText('Singaporean Remote')).toBeNull()
  })
})
