import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface StoredConfig {
  responsesTransport?: Record<string, number>
  upstreamTransport?: Record<string, number>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-transport-migration-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, transport: StoredConfig): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      { auth: { adminApiKey: "existing-admin-key" }, ...transport },
      null,
      2,
    )}\n`,
    "utf8",
  )
  return configPath
}

function readStoredConfig(configPath: string): StoredConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as StoredConfig
}

function runStartupMerge(tempDir: string): void {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    ],
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
      `Startup merge failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("upstreamTransport legacy key migration", () => {
  test("moves responsesTransport to upstreamTransport and drops the legacy key", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      responsesTransport: { streamInactivityTimeoutMs: 120_000 },
    })

    runStartupMerge(tempDir)

    const stored = readStoredConfig(configPath)
    expect(stored.upstreamTransport?.streamInactivityTimeoutMs).toBe(120_000)
    expect(stored.upstreamTransport?.headersTimeoutMs).toBe(300_000)
    expect(stored).not.toHaveProperty("responsesTransport")
  })

  test("moves the legacy headersTimeoutMsV2 key to headersTimeoutMs", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      responsesTransport: { headersTimeoutMsV2: 60_000 },
    })

    runStartupMerge(tempDir)

    const stored = readStoredConfig(configPath)
    expect(stored.upstreamTransport?.headersTimeoutMs).toBe(60_000)
    expect(stored.upstreamTransport).not.toHaveProperty("headersTimeoutMsV2")
    expect(stored).not.toHaveProperty("responsesTransport")
  })

  test("keeps upstreamTransport when a config already carries both keys", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      responsesTransport: { headersTimeoutMs: 15_000 },
      upstreamTransport: { headersTimeoutMs: 90_000 },
    })

    runStartupMerge(tempDir)

    const stored = readStoredConfig(configPath)
    expect(stored.upstreamTransport?.headersTimeoutMs).toBe(90_000)
    expect(stored).not.toHaveProperty("responsesTransport")
  })

  test("leaves configs already on the new key untouched", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      upstreamTransport: { headersTimeoutMs: 45_000 },
    })

    runStartupMerge(tempDir)

    const stored = readStoredConfig(configPath)
    expect(stored.upstreamTransport?.headersTimeoutMs).toBe(45_000)
  })
})
