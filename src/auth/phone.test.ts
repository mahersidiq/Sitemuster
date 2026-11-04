import { describe, expect, it } from 'vitest';

import { isValidEmail, maskEmail, maskPhone, normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['(555) 555-0123', '+15555550123'],
    ['555.555.0123', '+15555550123'],
    ['1 555 555 0123', '+15555550123'],
    ['+1 (555) 555-0123', '+15555550123'],
    ['+52 55 1234 5678', '+525512345678'],
  ])('accepts %j as %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 });
  });

  it.each(['', '123', '055-555-0123', '+0123456789', 'call me', '555-555-01234', '+1 555 555'])(
    'rejects %j (never invents a number)',
    (input) => {
      expect(normalizePhone(input)).toEqual({ ok: false });
    },
  );
});

describe('masking and email validation', () => {
  it('masks contact details for display', () => {
    expect(maskPhone('+15555550123')).toBe('+1 ••• ••• 0123');
    expect(maskEmail('name@company.com')).toBe('na•••@company.com');
  });

  it('validates email shape', () => {
    expect(isValidEmail('super@gc.example')).toBe(true);
    expect(isValidEmail('super@gc')).toBe(false);
    expect(isValidEmail('no spaces@gc.com')).toBe(false);
  });
});
