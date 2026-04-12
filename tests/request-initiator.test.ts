import { describe, expect, test } from "bun:test"

import { resolveEffectiveInitiator } from "~/lib/request-initiator"

describe("resolveEffectiveInitiator", () => {
  test("returns the base initiator for ordinary requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: false,
        isSubagent: false,
      }),
    ).toBe("user")
  })

  test("forces agent for compact requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: true,
        isSubagent: false,
      }),
    ).toBe("agent")
  })

  test("forces agent for subagent requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: false,
        isSubagent: true,
      }),
    ).toBe("agent")
  })
})
