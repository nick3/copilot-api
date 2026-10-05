import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Use a separate module graph so route mocks from other test files cannot hide request guards.
test("builtin Copilot defaults on, blocks all transports when disabled, and preserves other providers", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-provider-control-"),
  )
  try {
    const script = `
      import assert from "node:assert/strict"
      import fs from "node:fs"
      import { PATHS } from "./src/lib/paths"
      import { invalidateConfigCache } from "./src/lib/config-store"
      import { applyProviderManagementUpdate } from "./src/lib/provider-management"
      import { isGitHubCopilotEnabled } from "./src/lib/github-copilot-provider"
      import { copilotHeaders, copilotModelsHeaders, copilotWebSocketHeaders } from "./src/lib/api-config"
      import { listEnabledProviders } from "./src/lib/provider-config"
      import { setupCopilotToken } from "./src/lib/token"
      import { state } from "./src/lib/state"
      import { accountsManager } from "./src/lib/accounts-manager"
      import { createFallbackModel } from "./src/lib/provider-model"
      import { modelRoutes } from "./src/routes/models/route"
      PATHS.CONFIG_PATH = process.env.PROVIDER_CONTROL_CONFIG_PATH
      let config = { providers: { custom: { type: "openai-compatible", baseUrl: "https://custom.test", apiKey: "retain-key" } } }
      function save(next) { config = next; fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config)); invalidateConfigCache() }
      save(config)
      assert.equal(isGitHubCopilotEnabled(), true)
      state.copilotToken = "test-token"
      assert.equal(copilotHeaders(state).Authorization, "Bearer test-token")
      assert.ok(copilotModelsHeaders(state))
      assert.ok(copilotWebSocketHeaders({}))
      const model = createFallbackModel("copilot-test-model")
      model.supported_endpoints = ["/chat/completions"]
      model.model_picker_enabled = true
      accountsManager.getFirstAccountModels = () => ({ object: "list", data: [model] })
      globalThis.fetch = async (url) => {
        assert.ok(String(url).startsWith("https://custom.test"), "disabled Copilot must never be fetched")
        return Response.json({ data: [{ id: "custom-model" }] })
      }
      const models = async (codex = false) => (await (await modelRoutes.request("http://local/", { headers: codex ? { "User-Agent": "codex/0.160.0", version: "0.160.0" } : {} })).json())
      assert.ok((await models()).data.some(entry => entry.id === "copilot-test-model"))
      save(applyProviderManagementUpdate(config, { providers: { "github-copilot": { enabled: false } } }))
      assert.equal(isGitHubCopilotEnabled(), false)
      assert.deepEqual(listEnabledProviders(), ["custom"])
      for (const build of [() => copilotHeaders(state), () => copilotModelsHeaders(state), () => copilotWebSocketHeaders({})]) {
        assert.throws(build, error => error.response?.status === 403)
      }
      let tokenCalls = 0
      await assert.rejects(setupCopilotToken({ getCopilotToken: async () => { tokenCalls++; throw Error("unexpected token fetch") } }), error => error.response?.status === 403)
      assert.equal(tokenCalls, 0)
      assert.deepEqual((await models()).data.map(entry => entry.id), ["custom/custom-model"])
      const hiddenCatalog = await models(true)
      assert.ok(hiddenCatalog.models.every(entry => entry.slug.startsWith("custom/")))
      assert.ok(hiddenCatalog.models.some(entry => entry.slug === "custom/custom-model"))
      save(applyProviderManagementUpdate(config, { providers: { "github-copilot": { enabled: true, codexModels: ["copilot-test-model"] } } }))
      const selected = await models(true)
      assert.ok(selected.models.some(entry => entry.slug === "copilot-test-model"))
      assert.ok(selected.models.every(entry => entry.slug === "copilot-test-model" || entry.slug.startsWith("custom/")))
      save(applyProviderManagementUpdate(config, { providers: { "github-copilot": { codexModels: [] } } }))
      assert.ok((await models()).data.some(entry => entry.id === "copilot-test-model"))
      assert.ok((await models(true)).models.every(entry => entry.slug.startsWith("custom/")))
      assert.equal(config.providers.custom.apiKey, "retain-key")
      console.log("builtin-provider-checks-ok")
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_HOME: directory,
        PROVIDER_CONTROL_CONFIG_PATH: path.join(directory, "config.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, stderr: exit === 0 ? "" : stderr }).toEqual({
      exit: 0,
      stderr: "",
    })
    expect(stdout).toContain("builtin-provider-checks-ok")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
