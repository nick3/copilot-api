import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { HTTPError } from "../src/lib/error"
import {
  computeDiff,
  extractErrorDetails,
  toAccountContext,
  truncate,
} from "../src/lib/handler-utils"

test("truncate returns original when within limit", () => {
  expect(truncate("abc", 3)).toBe("abc")
  expect(truncate("abc", 10)).toBe("abc")
})

test("truncate appends ellipsis when exceeding limit", () => {
  expect(truncate("abcd", 3)).toBe("abc…")
})

test("computeDiff returns after-before for numbers", () => {
  expect(computeDiff(5, 8)).toBe(3)
})

test("computeDiff returns undefined if inputs are missing", () => {
  expect(computeDiff(undefined, 8)).toBeUndefined()
  expect(computeDiff(5, undefined)).toBeUndefined()
})

test("toAccountContext projects AccountRuntime to AccountContext", () => {
  const runtime: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
  }

  expect(toAccountContext(runtime)).toEqual({
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    accountType: "individual",
    vsCodeVersion: "1.0.0",
  })
})

test("extractErrorDetails handles non-HTTP errors", () => {
  const error = new Error("boom")
  const details = extractErrorDetails(error)

  expect(details.httpStatus).toBe(500)
  expect(details.errorStatus).toBeUndefined()
  expect(details.errorMessage).toBe("boom")
  expect(details.unauthorized).toBe(false)
})

test("extractErrorDetails handles HTTPError and detects unauthorized", () => {
  const error = new HTTPError(
    "nope",
    new Response("unauthorized", { status: 401 }),
  )

  const details = extractErrorDetails(error)

  expect(details.httpStatus).toBe(401)
  expect(details.errorStatus).toBe(401)
  expect(details.errorMessage).toBe("nope")
  expect(details.unauthorized).toBe(true)
})

test("truncate handles max parameter correctly", () => {
  expect(truncate("hello", 10)).toBe("hello")
  expect(truncate("hello", 5)).toBe("hello")
  expect(truncate("hello", 4)).toBe("hell…")
})

test("truncate uses default max of 2000", () => {
  const longString = "a".repeat(2001)
  const result = truncate(longString)

  expect(result.length).toBe(2001)
  expect(result.endsWith("…")).toBe(true)
})

test("truncate handles empty string", () => {
  expect(truncate("", 10)).toBe("")
})

test("truncate handles unicode characters", () => {
  expect(truncate("hello🎉", 6)).toBe("hello🎉")
  expect(truncate("hello🎉", 5)).toBe("hello…")
})

test("computeDiff returns positive difference", () => {
  expect(computeDiff(10, 15)).toBe(5)
})

test("computeDiff returns negative difference", () => {
  expect(computeDiff(20, 15)).toBe(-5)
})

test("computeDiff returns zero for equal values", () => {
  expect(computeDiff(10, 10)).toBe(0)
})

test("computeDiff handles decimals", () => {
  expect(computeDiff(1.5, 2.7)).toBe(1.2)
})

test("extractErrorDetails handles generic Error", () => {
  const error = new Error("Something went wrong")
  const details = extractErrorDetails(error)

  expect(details.errorName).toBe("Error")
  expect(details.errorMessage).toBe("Something went wrong")
  expect(details.httpStatus).toBe(500)
  expect(details.errorStatus).toBeUndefined()
  expect(details.unauthorized).toBe(false)
})

test("extractErrorDetails handles HTTPError with 404", () => {
  const { HTTPError } = require("../src/lib/error")

  const response = new Response("Not found", { status: 404 })
  const error = new HTTPError("Not found", response)
  const details = extractErrorDetails(error)

  expect(details.httpStatus).toBe(404)
  expect(details.errorStatus).toBe(404)
  expect(details.unauthorized).toBe(false)
})

test("extractErrorDetails truncates long error messages", () => {
  const longMessage = "a".repeat(3000)
  const error = new Error(longMessage)
  const details = extractErrorDetails(error)

  expect(details.errorMessage.length).toBeLessThan(longMessage.length)
  expect(details.errorMessage.endsWith("…")).toBe(true)
})

test("extractErrorDetails handles non-Error objects", () => {
  const details = extractErrorDetails("plain string error")

  expect(details.errorName).toBe("Error")
  expect(details.errorMessage).toBe("plain string error")
  expect(details.httpStatus).toBe(500)
})

test("extractErrorDetails handles null", () => {
  const details = extractErrorDetails(null)

  expect(details.errorName).toBe("Error")
  expect(details.errorMessage).toBe("null")
})

test("toAccountContext excludes runtime-only fields", () => {
  const runtime: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: 123456,
    githubToken: "ghp_token",
    copilotToken: "copilot_token",
    vsCodeVersion: "1.85.0",
    premiumRemaining: 100,
    unlimited: false,
    failed: false,
    models: undefined,
  }

  const context = toAccountContext(runtime)

  expect(context.githubToken).toBe("ghp_token")
  expect(context.copilotToken).toBe("copilot_token")
  expect(context.accountType).toBe("individual")
  expect(context.vsCodeVersion).toBe("1.85.0")

  expect((context as unknown as Record<string, unknown>).id).toBeUndefined()
  expect(
    (context as unknown as Record<string, unknown>).premiumRemaining,
  ).toBeUndefined()
  expect(
    (context as unknown as Record<string, unknown>).failed,
  ).toBeUndefined()
})
