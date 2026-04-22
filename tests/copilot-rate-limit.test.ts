import { expect, test } from "bun:test"

import {
  getCopilotRateLimitUsage,
  parseCopilotRateLimitHeader,
} from "../src/lib/copilot-rate-limit"

test("parseCopilotRateLimitHeader extracts remaining quota and reset time", () => {
  expect(
    parseCopilotRateLimitHeader(
      "ent=0&ov=0.0&ovPerm=false&rem=99.6&rst=2026-04-22T14%3A30%3A56Z",
    ),
  ).toEqual({
    remaining: "99.6",
    resetAt: "2026-04-22T14:30:56Z",
  })
})

test("getCopilotRateLimitUsage reads session and weekly headers", () => {
  const headers = new Headers({
    "x-usage-ratelimit-session":
      "ent=0&ov=0.0&ovPerm=false&rem=99.6&rst=2026-04-22T14%3A30%3A56Z",
    "x-usage-ratelimit-weekly":
      "ent=0&ov=0.0&ovPerm=false&rem=95.9&rst=2026-04-27T00%3A00%3A00Z",
  })

  expect(getCopilotRateLimitUsage(headers, "session")).toEqual({
    type: "session",
    remaining: "99.6",
    resetAt: "2026-04-22T14:30:56Z",
  })
  expect(getCopilotRateLimitUsage(headers, "weekly")).toEqual({
    type: "weekly",
    remaining: "95.9",
    resetAt: "2026-04-27T00:00:00Z",
  })
})
