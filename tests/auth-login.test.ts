import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  providers?: Record<string, unknown>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-auth-"))
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): void {
  fs.writeFileSync(
    path.join(tempDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
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
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("auth login validation", () => {
  test("rejects an unknown provider name before starting a login flow", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { runAuthLogin } = await import("./src/auth"); try { await runAuthLogin({ provider: "unknown", verbose: false, showToken: false }); console.log("unexpected-success"); } catch (error) { console.log((error instanceof Error ? error.message : String(error)).trim()); }',
    )

    expect(output).toBe(
      "Unknown provider 'unknown'. Expected one of: copilot, codex",
    )
  })
})
