import { expect, test } from "bun:test"

import {
  closeResponsesBridge,
  registerResponsesBridge,
  unregisterResponsesBridge,
} from "~/services/copilot/responses-bridge-registry"

test("closeResponsesBridge invokes the registered closer", () => {
  let closed = 0
  registerResponsesBridge("bridge-a", () => {
    closed += 1
  })

  closeResponsesBridge("bridge-a")

  expect(closed).toBe(1)
})

test("closeResponsesBridge is a no-op for unknown bridge ids", () => {
  expect(() => closeResponsesBridge("missing-bridge")).not.toThrow()
})

test("unregisterResponsesBridge stops the closer from firing", () => {
  let closed = 0
  registerResponsesBridge("bridge-b", () => {
    closed += 1
  })
  unregisterResponsesBridge("bridge-b")

  closeResponsesBridge("bridge-b")

  expect(closed).toBe(0)
})

test("a closer only fires once: a second close after teardown is a no-op", () => {
  let closed = 0
  registerResponsesBridge("bridge-c", () => {
    closed += 1
    // Real bridges unregister themselves on close.
    unregisterResponsesBridge("bridge-c")
  })

  closeResponsesBridge("bridge-c")
  closeResponsesBridge("bridge-c")

  expect(closed).toBe(1)
})

test("closeResponsesBridge swallows errors thrown by the closer", () => {
  registerResponsesBridge("bridge-d", () => {
    throw new Error("boom")
  })

  expect(() => closeResponsesBridge("bridge-d")).not.toThrow()
})
