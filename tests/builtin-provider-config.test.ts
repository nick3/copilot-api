import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  builtinProviders?: Record<string, unknown>
  contextManagement?: {
    messages?: boolean
    responses?: boolean
  }
  extraPrompts?: Record<string, string>
  modelAliases?: Record<string, { target: string; allowOriginal?: boolean }>
  modelReasoningEfforts?: Record<string, string>
  modelResponsesApiCompactThresholds?: Record<string, number>
  providers?: Record<
    string,
    {
      type?: string
      enabled?: boolean
      baseUrl?: string
      apiKey?: string
      authType?: string
    }
  >
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-builtin-provider-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

function readConfigFile(configPath: string): ConfigFileShape {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFileShape
}

function runScript(tempDir: string, script: string): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Script failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  return decoder.decode(result.stdout).trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("builtin provider config", () => {
  test("does not persist builtinProviders when missing", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).builtinProviders).toBeUndefined()
  })

  test("uses context management defaults by endpoint", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { isContextManagementEnabledForMessages, isContextManagementEnabledForResponses } = await import("./src/lib/config"); console.log(JSON.stringify({ messages: isContextManagementEnabledForMessages(), responses: isContextManagementEnabledForResponses() }));',
    )

    expect(JSON.parse(output)).toEqual({
      messages: true,
      responses: false,
    })
    expect(readConfigFile(configPath).contextManagement).toEqual({
      messages: true,
      responses: false,
    })
  })

  test("allows overriding context management per endpoint", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      contextManagement: {
        messages: false,
        responses: true,
      },
    })

    const output = runScript(
      tempDir,
      'const { isContextManagementEnabledForMessages, isContextManagementEnabledForResponses } = await import("./src/lib/config"); console.log(JSON.stringify({ messages: isContextManagementEnabledForMessages(), responses: isContextManagementEnabledForResponses() }));',
    )

    expect(JSON.parse(output)).toEqual({
      messages: false,
      responses: true,
    })
  })

  test("adds model Responses API compact thresholds by default", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { getModelResponsesApiCompactThreshold } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getModelResponsesApiCompactThreshold("gpt-5.4"), gpt55: getModelResponsesApiCompactThreshold("gpt-5.5"), gpt56Sol: getModelResponsesApiCompactThreshold("gpt-5.6-sol"), gpt56Terra: getModelResponsesApiCompactThreshold("gpt-5.6-terra"), gpt56Luna: getModelResponsesApiCompactThreshold("gpt-5.6-luna"), unknown: getModelResponsesApiCompactThreshold("gpt-test") ?? null }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: 217600,
      gpt55: 217600,
      gpt56Sol: 231200,
      gpt56Terra: 231200,
      gpt56Luna: 231200,
      unknown: null,
    })
    expect(
      readConfigFile(configPath).modelResponsesApiCompactThresholds,
    ).toEqual({
      "gpt-5.4": 217600,
      "gpt-5.5": 217600,
      "gpt-5.6-sol": 231200,
      "gpt-5.6-terra": 231200,
      "gpt-5.6-luna": 231200,
    })
  })

  test("does not add quick provider templates by default", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).providers).toEqual({})
  })

  test("does not add missing quick providers to existing provider config", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      providers: {
        deepseek: {
          apiKey: "custom-key",
          baseUrl: "https://custom.deepseek.example",
          enabled: false,
          type: "anthropic",
        },
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).providers).toEqual({
      deepseek: {
        apiKey: "custom-key",
        baseUrl: "https://custom.deepseek.example",
        enabled: false,
        type: "anthropic",
      },
    })
  })

  test("allows overriding model Responses API compact thresholds", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      modelResponsesApiCompactThresholds: {
        "gpt-5.4": 123456,
      },
    })

    const output = runScript(
      tempDir,
      'const { getModelResponsesApiCompactThreshold } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getModelResponsesApiCompactThreshold("gpt-5.4"), gpt55: getModelResponsesApiCompactThreshold("gpt-5.5") }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: 123456,
      gpt55: 217600,
    })
  })

  test("allows codex to be configured in config.providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: {
          type: "openai-responses",
          authType: "oauth2",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("codex")));',
    )

    expect(JSON.parse(output)).toMatchObject({
      name: "codex",
      type: "openai-responses",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: "",
    })
  })

  test("keeps copilot reserved for config.providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        copilot: {
          type: "openai-compatible",
          baseUrl: "https://example.com",
          apiKey: "provider-key",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("copilot")));',
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("requires apiKey for non-codex oauth2 providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        custom: {
          type: "openai-responses",
          authType: "oauth2",
          baseUrl: "https://example.com",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("custom")));',
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("returns commentary prompt for gpt-5.3+ models by default", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { getExtraPromptForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ codex: getExtraPromptForModel("gpt-5.3-codex").length > 0, gpt54: getExtraPromptForModel("gpt-5.4").length > 0, gpt55: getExtraPromptForModel("gpt-5.5").length > 0, gpt6: getExtraPromptForModel("gpt-6").length > 0, gpt52: getExtraPromptForModel("gpt-5.2").length > 0, unknown: getExtraPromptForModel("gpt-test") }));',
    )

    expect(JSON.parse(output)).toEqual({
      codex: true,
      gpt54: true,
      gpt55: true,
      gpt6: true,
      gpt52: false,
      unknown: "",
    })
  })

  test("returns commentary prompt for gpt-5.3+ alias targets by default", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      extraPrompts: {},
      modelAliases: {
        fast: {
          target: "gpt-5.4",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getExtraPromptForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ fast: getExtraPromptForModel("fast").length > 0 }));',
    )

    expect(JSON.parse(output)).toEqual({
      fast: true,
    })
  })

  test("returns xhigh reasoning effort for gpt-5.3+ models by default", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { getConfiguredReasoningEffortForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ codex: getConfiguredReasoningEffortForModel("gpt-5.3-codex"), gpt54: getConfiguredReasoningEffortForModel("gpt-5.4"), gpt55: getConfiguredReasoningEffortForModel("gpt-5.5"), gpt6: getConfiguredReasoningEffortForModel("gpt-6"), gpt52: getConfiguredReasoningEffortForModel("gpt-5.2") ?? null, unknown: getConfiguredReasoningEffortForModel("gpt-test") ?? null }));',
    )

    expect(JSON.parse(output)).toEqual({
      codex: "xhigh",
      gpt54: "xhigh",
      gpt55: "xhigh",
      gpt6: "xhigh",
      gpt52: null,
      unknown: null,
    })
  })

  test("user extraPrompts override takes priority over fallback", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      extraPrompts: {
        "gpt-5.4": "custom prompt",
      },
    })

    const output = runScript(
      tempDir,
      'const { getExtraPromptForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getExtraPromptForModel("gpt-5.4"), gpt55HasPrompt: getExtraPromptForModel("gpt-5.5").length > 0 }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: "custom prompt",
      gpt55HasPrompt: true,
    })
  })

  test("user modelReasoningEfforts override takes priority over fallback", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      modelReasoningEfforts: {
        "gpt-5.4": "medium",
      },
    })

    const output = runScript(
      tempDir,
      'const { getConfiguredReasoningEffortForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getConfiguredReasoningEffortForModel("gpt-5.4"), gpt55: getConfiguredReasoningEffortForModel("gpt-5.5") }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: "medium",
      gpt55: "xhigh",
    })
  })

  test("does not persist gpt-5.3+ extraPrompts in config file", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const writtenConfig = readConfigFile(configPath)
    expect(writtenConfig.extraPrompts).toBeDefined()
    expect(Object.keys(writtenConfig.extraPrompts ?? {})).toEqual([
      "gpt-5-mini",
    ])
  })

  test("does not persist gpt-5.3+ modelReasoningEfforts in config file", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).modelReasoningEfforts).toEqual({
      "gpt-5-mini": "low",
    })
  })
})
