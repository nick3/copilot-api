import { expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { isCopilotModelAvailable } from "../src/lib/model-availability"
import { getLatestModelForFamily } from "../src/lib/models"

const makeModels = (ids: Array<string>): Array<Model> =>
  ids.map((id) => ({
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: id,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: {},
    },
  }))

test("returns the highest version model for a family", () => {
  const models = makeModels([
    "claude-opus-4.5",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-sonnet-5",
    "claude-haiku-4.5",
    "claude-fable-5",
  ])

  expect(getLatestModelForFamily(models, "opus")?.id).toBe("claude-opus-4.8")
  expect(getLatestModelForFamily(models, "sonnet")?.id).toBe("claude-sonnet-5")
  expect(getLatestModelForFamily(models, "haiku")?.id).toBe("claude-haiku-4.5")
  expect(getLatestModelForFamily(models, "fable")?.id).toBe("claude-fable-5")
})

test("compares major before minor version", () => {
  const models = makeModels([
    "claude-sonnet-3.7",
    "claude-sonnet-4.1",
    "claude-3-5-sonnet",
  ])

  expect(getLatestModelForFamily(models, "sonnet")?.id).toBe(
    "claude-sonnet-4.1",
  )
})

test("handles mixed model ID formats", () => {
  const models = makeModels([
    "claude-3-opus-20240229",
    "claude-opus-4-5-20251101",
  ])

  expect(getLatestModelForFamily(models, "opus")?.id).toBe(
    "claude-opus-4-5-20251101",
  )
})

test("returns undefined when the family is unavailable", () => {
  const models = makeModels(["claude-sonnet-4.6", "gpt-5-mini"])

  expect(getLatestModelForFamily(models, "opus")).toBeUndefined()
})

test("returns undefined when no models are supplied", () => {
  expect(getLatestModelForFamily([], "sonnet")).toBeUndefined()
})

test("ignores disabled and hidden remote models", () => {
  const [disabled, hidden, available] = makeModels([
    "claude-sonnet-5.2",
    "claude-sonnet-5.1",
    "claude-sonnet-5",
  ])
  disabled.policy = { state: "disabled", terms: "" }
  hidden.model_picker_enabled = false

  expect(
    getLatestModelForFamily([disabled, hidden, available], "sonnet", {
      allowDisabledPolicy: false,
    })?.id,
  ).toBe("claude-sonnet-5")
})

test("keeps disabled-policy entries available in local model mode", () => {
  const [model] = makeModels(["claude-sonnet-5.2"])
  model.policy = { state: "disabled", terms: "" }

  expect(
    isCopilotModelAvailable(model, { allowDisabledPolicy: true }),
  ).toBeTrue()
})
