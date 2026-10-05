import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runAuthLogin } from "../src/auth"
import {
  getConfig,
  invalidateConfigCache,
  writeConfigToDisk,
} from "../src/lib/config"
import { installModelsDevCatalog } from "../src/lib/models-dev-cache"
import { PATHS } from "../src/lib/paths"
import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const originalPaths = { ...PATHS }
const originalPrompt = consola.prompt.bind(consola)
let directory: string
let answers: Array<string | undefined>
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "auth-provider-catalog-"))
  for (const key of Object.keys(PATHS) as Array<keyof typeof PATHS>) {
    PATHS[key] =
      key === "APP_DIR" ? directory : (
        path.join(directory, path.basename(originalPaths[key]))
      )
  }
  writeConfigToDisk({
    providers: {
      example: {
        codexModels: ["answer"],
        models: { answer: { temperature: 0.2 } },
        apiKey: "old-test-key",
      },
    },
  })
  invalidateConfigCache()
  installModelsDevCatalog({
    ...modelsDevCatalogFixture,
    example: {
      id: "example",
      name: "Example Provider",
      npm: "@ai-sdk/openai",
      api: "https://provider.test/v1",
      models: { answer: { id: "answer" } },
    },
  })
  answers = []
  consola.prompt = (() =>
    Promise.resolve(answers.shift())) as typeof consola.prompt
})
afterEach(async () => {
  consola.prompt = originalPrompt
  Object.assign(PATHS, originalPaths)
  invalidateConfigCache()
  await fs.rm(directory, { recursive: true, force: true })
})
test("catalog-based custom login retains model overrides and selected Codex models", async () => {
  answers = [
    "models-dev",
    "exam",
    "example",
    "",
    "openai-responses",
    "",
    "new-test-key",
    "__default__",
  ]
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("no network expected"),
  )
  try {
    await runAuthLogin({ provider: "custom", verbose: false, showToken: false })
    expect(getConfig().providers?.example).toMatchObject({
      modelsDevProviderId: "example",
      type: "openai-responses",
      baseUrl: "https://provider.test/v1",
      apiKey: "new-test-key",
      codexModels: ["answer"],
      models: { answer: { temperature: 0.2 } },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(answers).toEqual([])
  } finally {
    fetchSpy.mockRestore()
  }
})
test.each([
  [["models-dev", "no-match"], "No matching models.dev providers"],
  [["models-dev", "exam", "missing"], "No models.dev provider selected"],
  [[undefined], "No provider source selected"],
] as const)(
  "invalid catalog selection leaves provider config unchanged: %j",
  async (input, message) => {
    const before = await fs.readFile(PATHS.CONFIG_PATH, "utf8")
    answers = [...input]
    const error: unknown = await runAuthLogin({
      provider: "custom",
      verbose: false,
      showToken: false,
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect(await fs.readFile(PATHS.CONFIG_PATH, "utf8")).toBe(before)
  },
)
