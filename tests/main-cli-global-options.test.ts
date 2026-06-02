import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface DebugInfo {
  version: string
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
  }
}

interface PackageJson {
  version: string
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const packageJson = JSON.parse(
  // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
  // JSON.parse() can actually parse buffers
  fs.readFileSync(new URL("../package.json", import.meta.url)),
) as PackageJson
const tempApiHomes: Array<string> = []

function createTempApiHome(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-debug-"))
  tempApiHomes.push(tempDir)
  return tempDir
}

const defaultApiHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "copilot-api-debug-default-"),
)

const baseEnv = {
  ...process.env,
  COPILOT_API_HOME: defaultApiHome,
  COPILOT_API_OAUTH_APP: "",
  COPILOT_API_ENTERPRISE_URL: "",
}

const runDebugJson = (...args: Array<string>): DebugInfo => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", ...args, "debug", "--json"],
    cwd,
    env: baseEnv,
  })
  const stdout = decoder.decode(result.stdout)
  const stderr = decoder.decode(result.stderr)

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI command failed with exit code ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }

  return JSON.parse(stdout) as DebugInfo
}

afterEach(() => {
  fs.rmSync(defaultApiHome, { recursive: true, force: true })
  while (tempApiHomes.length > 0) {
    fs.rmSync(tempApiHomes.pop()!, { recursive: true, force: true })
  }
})

describe("root-level global CLI options", () => {
  test("keeps subcommands lazy so MCP can start under Node", () => {
    const source = fs.readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    )

    expect(source).not.toContain('const { start } = await import("./start")')
    expect(source).toMatch(/mcp:\s*\(\)\s*=>\s*import\("\.\/mcp"\)/)
  })

  test("reports the package version", () => {
    const info = runDebugJson()

    expect(info.version).toBe(packageJson.version)
  })

  test("supports --api-home=value before the subcommand", () => {
    const apiHome = createTempApiHome()
    const info = runDebugJson(`--api-home=${apiHome}`)

    expect(info.paths.APP_DIR).toBe(apiHome)
    expect(info.paths.GITHUB_TOKEN_PATH).toBe(
      path.join(apiHome, "github_token"),
    )
  })

  test("supports --oauth-app=value before the subcommand", () => {
    const info = runDebugJson("--oauth-app=opencode")

    expect(path.basename(path.dirname(info.paths.GITHUB_TOKEN_PATH))).toBe(
      "opencode",
    )
    expect(path.basename(info.paths.GITHUB_TOKEN_PATH)).toBe("github_token")
  })

  test("supports --enterprise-url=value before the subcommand", () => {
    const info = runDebugJson("--enterprise-url=ghe.example.com")

    expect(path.basename(info.paths.GITHUB_TOKEN_PATH)).toBe("ent_github_token")
  })

  test("supports combining root-level global CLI options", () => {
    const apiHome = createTempApiHome()
    const info = runDebugJson(
      `--api-home=${apiHome}`,
      "--oauth-app=myapp",
      "--enterprise-url=ghe.example.com",
    )

    expect(info.paths.APP_DIR).toBe(apiHome)
    expect(info.paths.GITHUB_TOKEN_PATH).toBe(
      path.join(apiHome, "myapp", "ent_github_token"),
    )
  })
})
