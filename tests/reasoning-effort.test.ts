import { describe, expect, test } from "bun:test"

import "./shared-admin-db-test-home"

import type { Model } from "~/services/copilot/get-models"

import {
  getReasoningEffortSupport,
  normalizeReasoningEffortForSupport,
  parseReasoningEffort,
  resolveReasoningEffortForTarget,
} from "~/lib/reasoning-effort"

const buildModel = (
  reasoningEffort?: Array<string>,
): Pick<Model, "capabilities"> => ({
  capabilities: {
    family: "test",
    limits: {},
    object: "capabilities",
    supports: {
      reasoning_effort: reasoningEffort,
    },
    tokenizer: "test",
    type: "chat",
  },
})

describe("reasoning effort normalization", () => {
  test("parses only canonical effort values", () => {
    expect(parseReasoningEffort("none")).toBe("none")
    expect(parseReasoningEffort("minimal")).toBe("minimal")
    expect(parseReasoningEffort("low")).toBe("low")
    expect(parseReasoningEffort("medium")).toBe("medium")
    expect(parseReasoningEffort("high")).toBe("high")
    expect(parseReasoningEffort("xhigh")).toBe("xhigh")
    expect(parseReasoningEffort("max")).toBe("max")
    expect(parseReasoningEffort("ultra")).toBeUndefined()
    expect(parseReasoningEffort(null)).toBeUndefined()
  })

  test("normalizes to the closest supported lower value on ties", () => {
    expect(
      normalizeReasoningEffortForSupport("max", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
    expect(
      normalizeReasoningEffortForSupport("minimal", ["low", "medium", "high"]),
    ).toBe("low")
    expect(
      normalizeReasoningEffortForSupport("xhigh", ["low", "medium", "high"]),
    ).toBe("high")
    expect(normalizeReasoningEffortForSupport("medium", ["low", "high"])).toBe(
      "low",
    )
  })

  test("omits effort when support is missing, empty, or unknown", () => {
    expect(
      normalizeReasoningEffortForSupport("high", undefined),
    ).toBeUndefined()
    expect(normalizeReasoningEffortForSupport("high", [])).toBeUndefined()
    expect(
      normalizeReasoningEffortForSupport("high", ["turbo", "ultra"]),
    ).toBeUndefined()
  })

  test("extracts sorted unique canonical support from model metadata", () => {
    expect(
      getReasoningEffortSupport(
        buildModel(["xhigh", "low", "low", "ultra", "medium"]),
      ),
    ).toEqual(["low", "medium", "xhigh"])
  })

  test("uses explicit effort before configured default", () => {
    const model = buildModel(["low", "medium", "high", "xhigh"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: "max",
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "low",
      }),
    ).toBe("xhigh")
  })

  test("uses configured default when explicit effort is omitted or invalid", () => {
    const model = buildModel(["low", "medium"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "high",
      }),
    ).toBe("medium")

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: "ultra",
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "high",
      }),
    ).toBe("medium")
  })

  test("uses configured model default when no default resolver is provided", () => {
    const model = buildModel(["low", "medium", "high"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "gpt-5-mini",
        targetModel: model,
      }),
    ).toBe("low")
  })

  test("omits effort when explicit and configured default are missing", () => {
    const model = buildModel(["low", "medium", "high"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "unconfigured-reasoning-test-model",
        targetModel: model,
      }),
    ).toBeUndefined()
  })

  test("omits effort when default resolver has no value", () => {
    const model = buildModel(["low", "medium", "high"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => undefined,
      }),
    ).toBeUndefined()
  })
})
