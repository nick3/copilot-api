import type { Database } from "bun:sqlite"

import consola from "consola"

import { getAdminDb, getAdminDbPath, getAdminDbUserVersion } from "./admin-db"

const INSERT_WARN_THROTTLE_MS = 30_000
const STORE_INIT_WARN_THROTTLE_MS = 30_000
const STORE_INIT_RETRY_DELAY_MS = 30_000

let lastInsertWarnAtMs = 0
let suppressedInsertWarnCount = 0
let lastStoreInitWarnAtMs = 0
let suppressedStoreInitWarnCount = 0
let nextStoreRetryAtMs = 0

export const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^x-github-token$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^proxy-authorization$/i,
  /^x-api-key$/i,
  /-token$/i,
  /-secret$/i,
] as const

function warnInsertFailure(error: unknown): void {
  const now = Date.now()

  if (now - lastInsertWarnAtMs < INSERT_WARN_THROTTLE_MS) {
    suppressedInsertWarnCount++
    return
  }

  const suppressed = suppressedInsertWarnCount
  suppressedInsertWarnCount = 0
  lastInsertWarnAtMs = now

  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(`Failed to insert request outbound${suffix}`, error)
}

function warnStoreInitFailure(error: unknown): void {
  const now = Date.now()

  if (now - lastStoreInitWarnAtMs < STORE_INIT_WARN_THROTTLE_MS) {
    suppressedStoreInitWarnCount++
    return
  }

  const suppressed = suppressedStoreInitWarnCount
  suppressedStoreInitWarnCount = 0
  lastStoreInitWarnAtMs = now

  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(`Request outbound store is disabled${suffix}`, error)
}

type HeaderMap = Record<string, string>

function shouldRedactHeader(key: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key))
}

export function getRedactedHeaderKeys(headers: HeaderMap): Array<string> {
  return Object.keys(headers).filter((key) => shouldRedactHeader(key))
}

export function redactHeaders(headers: HeaderMap): HeaderMap {
  const redacted: HeaderMap = {}

  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = shouldRedactHeader(key) ? "***" : value
  }

  return redacted
}

export type OutboundCaptureInput = {
  requestId: string
  httpStatus: number
  upstreamUrl: string
  upstreamMethod: string
  requestHeaders: HeaderMap
  requestBody: string | null
  requestBodyKind: string
  responseStatus: number
  responseHeaders: HeaderMap
  responseBody: string | null
  responseBodyKind: string
}

export type OutboundCaptureRow = OutboundCaptureInput & {
  capturedAtMs: number
}

export type RequestOutboundStoreApi = {
  insert(input: OutboundCaptureInput): void
  getByRequestId(requestId: string): OutboundCaptureRow | null
  cleanupOrphans(): void
  meta(): {
    dbPath: string
    userVersion: number
  }
}

class RequestOutboundStore implements RequestOutboundStoreApi {
  private readonly db: Database
  private readonly insertStmt: ReturnType<Database["query"]>
  private readonly getByRequestIdStmt: ReturnType<Database["query"]>
  private readonly cleanupOrphansStmt: ReturnType<Database["query"]>

  constructor(db: Database) {
    this.db = db
    this.insertStmt = db.query(`
      INSERT OR REPLACE INTO request_outbound (
        request_id,
        captured_at_ms,
        http_status,
        upstream_url,
        upstream_method,
        request_headers,
        request_body,
        request_body_kind,
        response_status,
        response_headers,
        response_body,
        response_body_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `)
    this.getByRequestIdStmt = db.query(`
      SELECT
        request_id,
        captured_at_ms,
        http_status,
        upstream_url,
        upstream_method,
        request_headers,
        request_body,
        request_body_kind,
        response_status,
        response_headers,
        response_body,
        response_body_kind
      FROM request_outbound
      WHERE request_id = ?
      LIMIT 1;
    `)
    this.cleanupOrphansStmt = db.query(`
      DELETE FROM request_outbound
      WHERE NOT EXISTS (
        SELECT 1
        FROM request_log
        WHERE request_log.request_id = request_outbound.request_id
      );
    `)
  }

  insert(input: OutboundCaptureInput): void {
    try {
      this.insertStmt.run(
        input.requestId,
        Date.now(),
        input.httpStatus,
        input.upstreamUrl,
        input.upstreamMethod,
        JSON.stringify(redactHeaders(input.requestHeaders)),
        input.requestBody,
        input.requestBodyKind,
        input.responseStatus,
        JSON.stringify(input.responseHeaders),
        input.responseBody,
        input.responseBodyKind,
      )
    } catch (error) {
      warnInsertFailure(error)
    }
  }

  getByRequestId(requestId: string): OutboundCaptureRow | null {
    try {
      const row = this.getByRequestIdStmt.get(requestId) as
        | {
            request_id: string
            captured_at_ms: number
            http_status: number
            upstream_url: string
            upstream_method: string
            request_headers: string
            request_body: string | null
            request_body_kind: string
            response_status: number
            response_headers: string
            response_body: string | null
            response_body_kind: string
          }
        | null
        | undefined

      if (!row) {
        return null
      }

      return {
        requestId: row.request_id,
        capturedAtMs: row.captured_at_ms,
        httpStatus: row.http_status,
        upstreamUrl: row.upstream_url,
        upstreamMethod: row.upstream_method,
        requestHeaders: JSON.parse(row.request_headers) as HeaderMap,
        requestBody: row.request_body,
        requestBodyKind: row.request_body_kind,
        responseStatus: row.response_status,
        responseHeaders: JSON.parse(row.response_headers) as HeaderMap,
        responseBody: row.response_body,
        responseBodyKind: row.response_body_kind,
      }
    } catch (error) {
      consola.debug("Failed to fetch request outbound by request_id", error)
      return null
    }
  }

  cleanupOrphans(): void {
    try {
      this.cleanupOrphansStmt.run()
    } catch (error) {
      consola.debug("Failed to cleanup request_outbound orphans", error)
    }
  }

  meta(): { dbPath: string; userVersion: number } {
    return {
      dbPath: getAdminDbPath(),
      userVersion: getAdminDbUserVersion(this.db),
    }
  }
}

export function createRequestOutboundStore(
  db: Database,
): RequestOutboundStoreApi {
  return new RequestOutboundStore(db)
}

const disabledStore: RequestOutboundStoreApi = {
  insert: () => {},
  getByRequestId: () => null,
  cleanupOrphans: () => {},
  meta: () => ({
    dbPath: getAdminDbPath(),
    userVersion: 0,
  }),
}

let sharedStore: RequestOutboundStoreApi | null = null

export function getRequestOutboundStore(): RequestOutboundStoreApi {
  if (sharedStore) {
    return sharedStore
  }

  const now = Date.now()
  if (now < nextStoreRetryAtMs) {
    return disabledStore
  }

  try {
    sharedStore = createRequestOutboundStore(getAdminDb())
    return sharedStore
  } catch (error) {
    nextStoreRetryAtMs = now + STORE_INIT_RETRY_DELAY_MS
    warnStoreInitFailure(error)
    return disabledStore
  }
}
