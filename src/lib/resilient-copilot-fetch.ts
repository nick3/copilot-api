import consola from "consola"
import { events } from "fetch-event-stream"

import { getCopilotRateLimiter } from "./copilot-rate-limiter"
import { HTTPError } from "./error"
import { state } from "./state"
import { sleep as defaultSleep } from "./utils"

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 60_000

type RetryableStatus = 429 | 500 | 502 | 503 | 504

type SleepFn = (ms: number) => Promise<void>

type BaseOptions = {
  accountId: string
  operation: string
  url: string
  init: RequestInit
  maxRetries?: number
  /** @internal For tests */
  sleep?: SleepFn
}

type JsonOptions = BaseOptions & {
  timeoutMs?: number
  failureMessage: string
}

type StreamOptions = BaseOptions & {
  connectTimeoutMs?: number
  firstEventTimeoutMs?: number
  failureMessage: string
}

export function addJitter(ms: number, ratio: number = 0.2): number {
  if (ms <= 0) return 0
  const span = ms * ratio
  const r = (Math.random() * 2 - 1) * span
  return Math.max(0, Math.round(ms + r))
}

export function parseRetryAfterToMs(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  // delta-seconds
  const asInt = Number.parseInt(trimmed, 10)
  if (Number.isFinite(asInt) && String(asInt) === trimmed) {
    return Math.max(0, asInt * 1000)
  }

  // HTTP-date
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, parsed - nowMs)
}

function getRetryAfterBaseMs(response: Response, nowMs: number): number {
  const retryAfter = response.headers.get("retry-after")
  const parsed = parseRetryAfterToMs(retryAfter, nowMs)
  if (parsed !== undefined) return parsed

  // GitHub-specific header sometimes exposed through Copilot.
  const ghUserRetryAfter = response.headers.get("x-ratelimit-user-retry-after")
  const ghParsed = parseRetryAfterToMs(ghUserRetryAfter, nowMs)
  if (ghParsed !== undefined) return ghParsed

  // Fallback: be conservative.
  return 60_000
}

function isRetryableStatus(status: number): status is RetryableStatus {
  return (
    status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
  )
}

function getExponentialBackoffMs(retryAttempt: number): number {
  // retryAttempt: 1..maxRetries => 1s,2s,4s,8s,16s
  const seconds = Math.min(16, 2 ** (retryAttempt - 1))
  return seconds * 1000
}

async function waitForRateLimitRetry(params: {
  limiter: ReturnType<typeof getCopilotRateLimiter>
  response: Response
  accountId: string
  operation: string
  retryAttempt: number
  maxRetries: number
  sleep: SleepFn
}): Promise<void> {
  const {
    limiter,
    response,
    accountId,
    operation,
    retryAttempt,
    maxRetries,
    sleep,
  } = params

  const nowMs = Date.now()
  const baseMs = getRetryAfterBaseMs(response, nowMs)
  const waitMs = addJitter(baseMs)
  const baseSeconds = Math.max(1, Math.ceil(baseMs / 1000))

  consola.warn(
    `[retry] Rate limit hit for ${operation} (account=${accountId}) (attempt ${retryAttempt + 1}/${maxRetries}). Waiting ${Math.round(waitMs / 100) / 10}s before retry...`,
  )

  if (state.rateLimitSeconds !== undefined) {
    limiter.noteRateLimitHit(baseSeconds, waitMs)
    return
  }

  await sleep(waitMs)
}

async function waitForRetryableHttpStatus(params: {
  status: number
  accountId: string
  operation: string
  retryAttempt: number
  maxRetries: number
  sleep: SleepFn
}): Promise<void> {
  const { status, accountId, operation, retryAttempt, maxRetries, sleep } =
    params

  const backoffMs = addJitter(getExponentialBackoffMs(retryAttempt + 1))

  consola.warn(
    `[retry] Transient HTTP ${status} for ${operation} (account=${accountId}) (attempt ${retryAttempt + 1}/${maxRetries}). Waiting ${Math.round(backoffMs / 100) / 10}s before retry...`,
  )

  await sleep(backoffMs)
}

function describeError(error: unknown): string {
  return error instanceof Error ?
      `${error.name}: ${error.message}`
    : String(error)
}

async function waitForRetryableError(params: {
  operation: string
  accountId: string
  retryAttempt: number
  maxRetries: number
  error: unknown
  stream: boolean
  sleep: SleepFn
}): Promise<void> {
  const {
    operation,
    accountId,
    retryAttempt,
    maxRetries,
    error,
    stream,
    sleep,
  } = params

  const backoffMs = addJitter(getExponentialBackoffMs(retryAttempt + 1))
  const details = describeError(error)

  consola.warn(
    `[retry] Transient${stream ? " stream" : ""} error for ${operation} (account=${accountId}) (attempt ${retryAttempt + 1}/${maxRetries}): ${details}. Waiting ${Math.round(backoffMs / 100) / 10}s before retry...`,
  )

  await sleep(backoffMs)
}

async function prefetchFirstEvent<T>(params: {
  iterator: AsyncIterator<T>
  controller: AbortController
  firstEventTimeoutMs: number
}): Promise<IteratorResult<T>> {
  const { iterator, controller, firstEventTimeoutMs } = params

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race<IteratorResult<T>>([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new Error(
              `Stream first event timeout after ${firstEventTimeoutMs}ms`,
            ),
          )
        }, firstEventTimeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined"
      && error instanceof DOMException
      && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  )
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const maybe = error as { code?: unknown }
  return typeof maybe.code === "string" ? maybe.code : undefined
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) return false
  return (
    code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ECONNREFUSED"
    || code === "EAI_AGAIN"
    || code === "ENOTFOUND"
    || code === "EPIPE"
  )
}

function shouldRetryError(error: unknown): boolean {
  if (isAbortError(error)) return true
  if (isRetryableNetworkError(error)) return true

  if (error instanceof Error) {
    if (error.message.startsWith("Stream first event timeout")) return true
    if (error.message === "Upstream stream ended before first event")
      return true
  }

  // Bun often throws TypeError("fetch failed") on network issues.
  if (error instanceof TypeError) return true

  return false
}

function responseToHttpError(message: string, response: Response): HTTPError {
  return new HTTPError(message, response)
}

function makeGatewayErrorResponse(
  status: 502 | 504,
  message: string,
): Response {
  return Response.json({ message }, { status })
}

function wrapFinalNonHttpError(
  failureMessage: string,
  error: unknown,
): HTTPError {
  const details =
    error instanceof Error ?
      `${error.name}: ${error.message}`
    : `Unknown error: ${String(error)}`

  const status: 502 | 504 = isAbortError(error) ? 504 : 502

  return new HTTPError(
    failureMessage,
    makeGatewayErrorResponse(status, `${failureMessage}. ${details}`),
  )
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{
  response: Response
  controller: AbortController
  clear: () => void
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })

    return {
      response,
      controller,
      clear: () => clearTimeout(timeout),
    }
  } catch (error) {
    clearTimeout(timeout)
    throw error
  }
}

export async function copilotFetchJsonWithRetry<T>(
  options: JsonOptions,
): Promise<T> {
  const {
    accountId,
    operation,
    url,
    init,
    failureMessage,
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep: sleepOverride,
  } = options

  const sleepFn = sleepOverride ?? defaultSleep

  const limiter = getCopilotRateLimiter(accountId)

  let lastNonHttpError: unknown = undefined

  for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt += 1) {
    try {
      await limiter.acquire()

      const { response, clear } = await fetchWithTimeout(url, init, timeoutMs)
      try {
        if (response.ok) {
          return (await response.json()) as T
        }

        if (!isRetryableStatus(response.status)) {
          throw responseToHttpError(failureMessage, response)
        }

        if (retryAttempt === maxRetries) {
          throw responseToHttpError(failureMessage, response)
        }

        if (response.status === 429) {
          await waitForRateLimitRetry({
            limiter,
            response,
            accountId,
            operation,
            retryAttempt,
            maxRetries,
            sleep: sleepFn,
          })

          continue
        }

        await waitForRetryableHttpStatus({
          status: response.status,
          accountId,
          operation,
          retryAttempt,
          maxRetries,
          sleep: sleepFn,
        })
        continue
      } finally {
        clear()
      }
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error
      }

      lastNonHttpError = error

      if (!shouldRetryError(error)) {
        throw wrapFinalNonHttpError(failureMessage, error)
      }

      if (retryAttempt === maxRetries) {
        throw wrapFinalNonHttpError(failureMessage, error)
      }

      await waitForRetryableError({
        operation,
        accountId,
        retryAttempt,
        maxRetries,
        error,
        stream: false,
        sleep: sleepFn,
      })
    }
  }

  throw wrapFinalNonHttpError(
    failureMessage,
    lastNonHttpError ?? new Error("Retry loop ended unexpectedly"),
  )
}

async function* asyncIterableFromIterator<T>(
  iterator: AsyncIterator<T>,
): AsyncIterable<T> {
  while (true) {
    const next = await iterator.next()
    if (next.done) return
    yield next.value
  }
}

export async function copilotFetchEventsWithRetry(
  options: StreamOptions,
): Promise<AsyncIterable<unknown>> {
  const {
    accountId,
    operation,
    url,
    init,
    failureMessage,
    maxRetries = DEFAULT_MAX_RETRIES,
    connectTimeoutMs = DEFAULT_TIMEOUT_MS,
    firstEventTimeoutMs = DEFAULT_FIRST_EVENT_TIMEOUT_MS,
    sleep: sleepOverride,
  } = options

  const sleepFn = sleepOverride ?? defaultSleep

  const limiter = getCopilotRateLimiter(accountId)

  let lastNonHttpError: unknown = undefined

  for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt += 1) {
    try {
      await limiter.acquire()

      const { response, controller, clear } = await fetchWithTimeout(
        url,
        init,
        connectTimeoutMs,
      )

      clear()

      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          throw responseToHttpError(failureMessage, response)
        }

        if (retryAttempt === maxRetries) {
          throw responseToHttpError(failureMessage, response)
        }

        if (response.status === 429) {
          await waitForRateLimitRetry({
            limiter,
            response,
            accountId,
            operation,
            retryAttempt,
            maxRetries,
            sleep: sleepFn,
          })

          continue
        }

        await waitForRetryableHttpStatus({
          status: response.status,
          accountId,
          operation,
          retryAttempt,
          maxRetries,
          sleep: sleepFn,
        })
        continue
      }

      const iterable = events(response)
      const iterator = (iterable as AsyncIterable<unknown>)[
        Symbol.asyncIterator
      ]()

      const first = await prefetchFirstEvent({
        iterator,
        controller,
        firstEventTimeoutMs,
      })

      if (first.done) {
        throw new Error("Upstream stream ended before first event")
      }

      return (async function* () {
        yield first.value
        yield* asyncIterableFromIterator(iterator)
      })()
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error
      }

      lastNonHttpError = error

      if (!shouldRetryError(error)) {
        throw wrapFinalNonHttpError(failureMessage, error)
      }

      if (retryAttempt === maxRetries) {
        throw wrapFinalNonHttpError(failureMessage, error)
      }

      await waitForRetryableError({
        operation,
        accountId,
        retryAttempt,
        maxRetries,
        error,
        stream: true,
        sleep: sleepFn,
      })
    }
  }

  throw wrapFinalNonHttpError(
    failureMessage,
    lastNonHttpError ?? new Error("Retry loop ended unexpectedly"),
  )
}
