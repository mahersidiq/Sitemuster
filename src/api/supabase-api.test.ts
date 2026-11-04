import { describe, expect, it } from 'vitest';

import { errorCode, errorMessageKey, sensitiveChangesOf } from './errors';
import { toApiError } from './supabase-api';
import { ApiError } from './types';

describe('server error mapping', () => {
  it('keeps machine codes and details raised by database functions', () => {
    const error = toApiError({
      code: '22023',
      message: 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: GEOFENCE_ENLARGED,DWELL_REDUCED',
    });
    expect(error).toMatchObject({ code: 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION' });
    expect(sensitiveChangesOf(error)).toEqual(['GEOFENCE_ENLARGED', 'DWELL_REDUCED']);
    // A specific code wins over the generic permission errcode.
    expect(toApiError({ code: '42501', message: 'DELEGATION_REQUIRES_ORG_ADMIN' }).code).toBe(
      'DELEGATION_REQUIRES_ORG_ADMIN',
    );
  });

  it('maps permission, session and transport failures without leaking server text', () => {
    expect(
      toApiError({ code: '42501', message: 'multi-factor authentication required' }).code,
    ).toBe('FORBIDDEN');
    expect(toApiError({ code: 'PGRST301', message: 'JWT expired' }).code).toBe('UNAUTHENTICATED');
    expect(toApiError({ name: 'TypeError', message: 'Network request failed' }).code).toBe(
      'NETWORK',
    );
    expect(toApiError({ code: 'XX000', message: 'internal detail with table names' }).code).toBe(
      'UNKNOWN',
    );
    expect(toApiError(null).code).toBe('UNKNOWN');
  });

  it('only shows translated messages for known codes', () => {
    expect(errorMessageKey(new ApiError('RADIUS_OUT_OF_BOUNDS'))).toBe(
      'apiErrors.RADIUS_OUT_OF_BOUNDS',
    );
    expect(errorCode(new ApiError('SOMETHING_NEW'))).toBe('UNKNOWN');
    expect(errorCode(new Error('boom'))).toBe('UNKNOWN');
    expect(sensitiveChangesOf(new ApiError('FORBIDDEN'))).toBeNull();
  });
});
