import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  builtinProviders?: Record<string, unknown>
  modelResponsesApiCompactThresholds?: Record<string, number>
  useResponsesApiContextManagement?: boolean
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

  test("enables Responses API context management by default", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { isResponsesApiContextManagementEnabled } = await import("./src/lib/config"); console.log(JSON.stringify({ enabled: isResponsesApiContextManagementEnabled() }));',
    )

    expect(JSON.parse(output)).toEqual({ enabled: true })
    expect(readConfigFile(configPath).useResponsesApiContextManagement).toBe(
      true,
    )
  })

  test("allows disabling Responses API context management", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      useResponsesApiContextManagement: false,
    })

    const output = runScript(
      tempDir,
      'const { isResponsesApiContextManagementEnabled } = await import("./src/lib/config"); console.log(JSON.stringify({ enabled: isResponsesApiContextManagementEnabled() }));',
    )

    expect(JSON.parse(output)).toEqual({ enabled: false })
  })

  test("adds model Responses API compact thresholds by default", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { getModelResponsesApiCompactThreshold } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getModelResponsesApiCompactThreshold("gpt-5.4"), gpt55: getModelResponsesApiCompactThreshold("gpt-5.5"), unknown: getModelResponsesApiCompactThreshold("gpt-test") ?? null }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: 217600,
      gpt55: 217600,
      unknown: null,
    })
    expect(
      readConfigFile(configPath).modelResponsesApiCompactThresholds,
    ).toEqual({
      "gpt-5.4": 217600,
      "gpt-5.5": 217600,
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
})
