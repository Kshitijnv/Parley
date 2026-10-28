// Revision 4 A1 (BUG-006): rejected keys are `auth`, and a 403 that isn't about the key
// is not. Pure classifier checks with synthetic bodies in Google's error shape.
import { expect, test } from '@playwright/test'
import { APICallError } from 'ai'
import { classify, errorInfoReason } from '../../src/main/ai/gemini'

const err = (status: number, body: object) => new APICallError({ message: `HTTP ${status}`, url: 'https://x.invalid', requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify(body) })
const info = (status: number, code: string, reason?: string) => ({ error: { code: status, status: code, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } })

test('AR-01 Gemini 400 API_KEY_INVALID is auth / invalid_key', () => {
  const e = classify(err(400, info(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID')), 'google')
  expect(e.kind).toBe('auth')
  expect(e.authKind).toBe('invalid_key')
})

test('401 is auth / invalid_key', () => {
  const e = classify(err(401, info(401, 'UNAUTHENTICATED')), 'openai')
  expect(e.kind).toBe('auth')
  expect(e.authKind).toBe('invalid_key')
})

test('403 about the key is auth / forbidden', () => {
  for (const r of ['API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED']) {
    const e = classify(err(403, info(403, 'PERMISSION_DENIED', r)), 'google')
    expect(e.kind, r).toBe('auth')
    expect(e.authKind, r).toBe('forbidden')
  }
})

test('AR-03 a 403 not about the key (region) is bad_request, never auth', () => {
  const e = classify(err(403, { error: { code: 403, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }), 'google')
  expect(e.kind).toBe('bad_request')
  expect(e.authKind).toBeUndefined()
})

test('a plain 400 stays bad_request; a 429 is never auth', () => {
  expect(classify(err(400, info(400, 'INVALID_ARGUMENT')), 'google').kind).toBe('bad_request')
  expect(classify(err(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }), 'google').kind).not.toBe('auth')
})

test('errorInfoReason reads only a short enum, and nothing from non-JSON', () => {
  expect(errorInfoReason(JSON.stringify(info(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID')))).toBe('API_KEY_INVALID')
  expect(errorInfoReason('<html>oops</html>')).toBeNull()
  expect(errorInfoReason(JSON.stringify({ error: { status: 'has spaces and the key sk-123' } }))).toBeNull()
})
