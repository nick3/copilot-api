import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import "./shared-admin-db-test-home"

import type { Model } from "~/services/copilot/get-models"

import {
  getConfiguredReasoningEffortForModel,
  mergeConfigWithDefaults,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
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

let configBeforeTest: string | null | undefined

const readConfigText = async (): Promise<string | null> =>
  await fs.readFile(PATHS.CONFIG_PATH, "utf8").catch(() => null)

const restoreConfigText = async (configText: string | null): Promise<void> => {
  if (configText === null) {
    await fs.rm(PATHS.CONFIG_PATH, { force: true })
  } else {
    await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
    await fs.writeFile(PATHS.CONFIG_PATH, configText, "utf8")
  }
  mergeConfigWithDefaults()
}

const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()
}

beforeEach(async () => {
  configBeforeTest = await readConfigText()
})

afterEach(async () => {
  if (configBeforeTest !== undefined) {
    await restoreConfigText(configBeforeTest)
    configBeforeTest = undefined
  }
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

  test("uses request model default before target model default", () => {
    const model = buildModel(["low", "medium", "high"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "requested-model",
        targetModel: model,
        targetModelId: "target-model",
        defaultEffortResolver: (modelId) => {
          if (modelId === "requested-model") return "max"
          if (modelId === "target-model") return "low"
          return undefined
        },
      }),
    ).toBe("high")
  })

  test("uses target model default when request model has none", () => {
    const model = buildModel(["low", "medium", "high"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "requested-model",
        targetModel: model,
        targetModelId: "target-model",
        defaultEffortResolver: (modelId) =>
          modelId === "target-model" ? "medium" : undefined,
      }),
    ).toBe("medium")
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
        targetModelId: "gpt-target",
        defaultEffortResolver: () => undefined,
      }),
    ).toBeUndefined()
  })

  test("uses alias target configured default when alias has no direct value", async () => {
    await writeConfig({
      modelAliases: {
        fast: {
          target: "gpt-5-mini",
        },
      },
      modelReasoningEfforts: {},
    })

    expect(getConfiguredReasoningEffortForModel("fast")).toBe("low")
  })

  test("uses direct alias configured default before alias target default", async () => {
    await writeConfig({
      modelAliases: {
        fast: {
          target: "gpt-5-mini",
        },
      },
      modelReasoningEfforts: {
        fast: "medium",
      },
    })

    expect(getConfiguredReasoningEffortForModel("fast")).toBe("medium")
  })

  test("uses gpt-5-mini base default for dated gpt-5-mini variants", async () => {
    await writeConfig({
      modelReasoningEfforts: {},
    })

    expect(getConfiguredReasoningEffortForModel("gpt-5-mini-2026-01-01")).toBe(
      "low",
    )
  })
})
