import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { accountsManager } from "../src/lib/accounts-manager"
import {
  getConfig,
  reloadConfig,
  writeConfigToDisk,
  invalidateConfigCache,
} from "../src/lib/config"
import { PATHS } from "../src/lib/paths"
import { adminApiRoutes } from "../src/routes/admin-api/route"

const originalConfigPath = PATHS.CONFIG_PATH
let directory: string
let enableSpy: ReturnType<
  typeof spyOn<typeof accountsManager, "setCopilotEnabled">
>
let registrySpy: ReturnType<
  typeof spyOn<typeof accountsManager, "reloadRegistryNow">
>
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "admin-runtime-config-"))
  PATHS.CONFIG_PATH = path.join(directory, "config.json")
  writeConfigToDisk({
    providers: { custom: { apiKey: "retained-test-key" } },
    modelAliases: { "copilot/claude-opus-5.5": { target: "claude-opus-5.5" } },
  })
  reloadConfig()
  enableSpy = spyOn(accountsManager, "setCopilotEnabled").mockResolvedValue(
    undefined,
  )
  registrySpy = spyOn(accountsManager, "reloadRegistryNow").mockResolvedValue(
    undefined,
  )
})
afterEach(async () => {
  enableSpy.mockRestore()
  registrySpy.mockRestore()
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  await fs.rm(directory, { recursive: true, force: true })
})
const post = (url: string, body?: unknown) =>
  adminApiRoutes.request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

test("Admin saves provider small models, Copilot switch and Codex visibility with runtime activation", async () => {
  const response = await post("/config", {
    smallModels: { copilot: "alias", codex: "", custom: "custom-mini" },
    providers: {
      "github-copilot": { enabled: false, codexModels: [] },
      custom: {
        apiKey: "retained-test-key",
        modelsDevProviderId: "openai",
        codexModels: ["gpt-test"],
        models: { "gpt-test": { codex: { enabled: false } } },
      },
    },
  })
  expect(response.status).toBe(200)
  const config = await response.json()
  expect(config).toMatchObject({
    _runtimeApplied: true,
    smallModels: { codex: "" },
    providers: {
      "github-copilot": { enabled: false, codexModels: [] },
      custom: { modelsDevProviderId: "openai", codexModels: ["gpt-test"] },
    },
    modelAliases: { "copilot/claude-opus-5.5": { target: "claude-opus-5.5" } },
  })
  expect(enableSpy).toHaveBeenCalledWith(false)
  expect(registrySpy).toHaveBeenCalledTimes(1)
})
test("saved configuration survives an activation failure and Reload retries it", async () => {
  enableSpy.mockRejectedValueOnce(new Error("temporary account failure"))
  const response = await post("/config", {
    smallModels: { copilot: "retry-model" },
  })
  expect(await response.json()).toMatchObject({
    _runtimeApplied: false,
    smallModels: { copilot: "retry-model" },
  })
  expect(
    JSON.parse(await fs.readFile(PATHS.CONFIG_PATH, "utf8")),
  ).toMatchObject({ smallModels: { copilot: "retry-model" } })
  expect(await (await post("/config/reload")).json()).toMatchObject({
    _runtimeApplied: true,
  })
})
test("invalid external configuration retains the last active configuration", async () => {
  await fs.writeFile(PATHS.CONFIG_PATH, "{")
  expect((await post("/config/reload")).status).toBe(500)
  expect(getConfig().providers?.custom.apiKey).toBe("retained-test-key")
  expect(enableSpy).not.toHaveBeenCalled()
})
test.each([
  { smallModels: { copilot: 4 } },
  { smallModels: { " ": "gpt-test" } },
  { providers: { "github-copilot": { apiKey: "wrong-field" } } },
  { providers: { copilot: { enabled: false } } },
  { providers: { custom: { codexModels: "invalid" } } },
  { providers: { custom: { modelsDevProviderId: 3 } } },
])("rejects invalid new config without changing disk: %j", async (body) => {
  const before = await fs.readFile(PATHS.CONFIG_PATH, "utf8")
  expect((await post("/config", body)).status).toBe(400)
  expect(await fs.readFile(PATHS.CONFIG_PATH, "utf8")).toBe(before)
})
