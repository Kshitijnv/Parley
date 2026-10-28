import { ZodError } from 'zod'
import { log } from './log'

/** An error whose message is written for the person using the app. */
export class AppError extends Error {
  constructor(
    message: string,
    public code: string = 'bad_request',
    public field?: string,
  ) {
    super(message)
  }
}

export interface WireError {
  message: string
  code: string
  field?: string
}

export function toWire(e: unknown): WireError {
  if (e instanceof AppError) return { message: e.message, code: e.code, field: e.field }
  if (e instanceof ZodError) {
    const issue = e.issues[0]
    return { message: issue?.message ?? 'Invalid input', code: 'validation', field: issue?.path.join('.') }
  }
  // Name, code and stack frames only: the message can hold provider or user text.
  const err = e as { name?: string; code?: unknown; stack?: string }
  log('unexpected_error', { errorName: err?.name ?? typeof e, errorCode: typeof err?.code === 'string' ? err.code : undefined, stack: err?.stack })
  return { message: 'Something went wrong. Try again.', code: 'internal' }
}
