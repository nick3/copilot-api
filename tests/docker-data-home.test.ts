import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const helper = fileURLToPath(new URL("../docker-data-home.sh", import.meta.url))
const entrypoint = fileURLToPath(new URL("../entrypoint.sh", import.meta.url))
let fixture: string
let current: string
let legacy: string
let mounts: string

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-container-home-"))
  current = path.join(fixture, "data")
  legacy = path.join(fixture, "root", ".local", "share", "copilot-api")
  mounts = path.join(fixture, "mountinfo")
  fs.mkdirSync(current, { recursive: true })
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(mounts, "")
})

afterEach(() => {
  fs.chmodSync(legacy, 0o700)
  fs.rmSync(fixture, { recursive: true, force: true })
})

function resolveHome(explicit = "") {
  return Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      '. "$1"; resolve_container_data_home "$2" "$3" "$4" "$5"',
      "test",
      helper,
      current,
      legacy,
      explicit,
      mounts,
    ],
  })
}

function mount(target: string): void {
  fs.appendFileSync(
    mounts,
    `100 99 8:1 / ${target} rw - ext4 /dev/fixture rw\n`,
  )
}

function seedLegacyState(): void {
  fs.writeFileSync(path.join(legacy, "config.json"), '{"logLevel":"debug"}')
  fs.writeFileSync(
    path.join(legacy, "accounts-registry.json"),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: "fixture-account", accountType: "enterprise", addedAt: 1 },
      ],
      clientIdentities: {},
    }),
  )
  fs.mkdirSync(path.join(legacy, "tokens"))
  fs.writeFileSync(
    path.join(legacy, "tokens", "github_fixture-account"),
    "fixture-only-token",
  )
}

test("new installs use the new container home", () => {
  const result = resolveHome()
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe(current)
})

test("old mounted state remains the selected config and account source", () => {
  seedLegacyState()
  mount(legacy)
  const result = resolveHome()
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe(legacy)
  const source = result.stdout.toString().trim()
  expect(
    JSON.parse(fs.readFileSync(path.join(source, "config.json"), "utf8")),
  ).toEqual({ logLevel: "debug" })
  expect(fs.existsSync(path.join(source, "accounts-registry.json"))).toBe(true)
  expect(
    fs.readFileSync(
      path.join(source, "tokens", "github_fixture-account"),
      "utf8",
    ),
  ).toBe("fixture-only-token")
  const readState = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
      import { getConfig } from ${JSON.stringify(fileURLToPath(new URL("../src/lib/config.ts", import.meta.url)))};
      import { listAccountsFromRegistry, loadAccountToken } from ${JSON.stringify(fileURLToPath(new URL("../src/lib/accounts-registry.ts", import.meta.url)))};
      console.log(JSON.stringify({
        logLevel: getConfig().logLevel,
        accounts: (await listAccountsFromRegistry()).map(account => account.id),
        tokenFound: Boolean(await loadAccountToken("fixture-account"))
      }));
    `,
    ],
    env: {
      ...process.env,
      COPILOT_API_HOME: source,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
  expect(readState.exitCode).toBe(0)
  expect(JSON.parse(readState.stdout.toString())).toEqual({
    logLevel: "debug",
    accounts: ["fixture-account"],
    tokenFound: true,
  })
  expect(fs.readdirSync(current)).toEqual([])
})

test("legacy state is detected even without a separate mount", () => {
  seedLegacyState()
  expect(resolveHome().stdout.toString().trim()).toBe(legacy)
})

test("an empty legacy mount is retained instead of writing to ephemeral data", () => {
  mount(legacy)
  expect(resolveHome().stdout.toString().trim()).toBe(legacy)
})

test("an inaccessible legacy mount is detected and never silently bypassed", () => {
  mount(legacy)
  fs.chmodSync(legacy, 0)
  expect(resolveHome().stdout.toString().trim()).toBe(legacy)
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      '. "$1"; validate_container_data_home "$2"',
      "test",
      helper,
      legacy,
    ],
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("data-init")
  expect(fs.readdirSync(current)).toEqual([])
})

test("two data locations require an explicit choice without merging or overwriting", () => {
  seedLegacyState()
  fs.writeFileSync(path.join(current, "config.json"), '{"logLevel":"info"}')
  const result = resolveHome()
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("COPILOT_API_HOME")
  expect(fs.readFileSync(path.join(current, "config.json"), "utf8")).toBe(
    '{"logLevel":"info"}',
  )
  expect(fs.readFileSync(path.join(legacy, "config.json"), "utf8")).toBe(
    '{"logLevel":"debug"}',
  )
})

test("two mounted homes also require an explicit choice", () => {
  mount(current)
  mount(legacy)
  expect(resolveHome().exitCode).not.toBe(0)
})

test("explicit environment or CLI home takes precedence", () => {
  seedLegacyState()
  mount(current)
  mount(legacy)
  const explicit = path.join(fixture, "custom")
  expect(resolveHome(explicit).stdout.toString().trim()).toBe(explicit)
})

test("state permission failures are actionable and leave file contents intact", () => {
  seedLegacyState()
  const config = path.join(legacy, "config.json")
  fs.chmodSync(config, 0o400)
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      '. "$1"; validate_container_data_home "$2"',
      "test",
      helper,
      legacy,
    ],
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("config.json")
  expect(result.stderr.toString()).toContain("data-init")
  expect(fs.readFileSync(config, "utf8")).toBe('{"logLevel":"debug"}')
})

test("entrypoint applies CLI home before persistence checks and Bun startup", () => {
  seedLegacyState()
  const bin = path.join(fixture, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, "bun"),
    '#!/bin/sh\nprintf "%s\\n" "$COPILOT_API_HOME"\n',
    { mode: 0o700 },
  )
  const result = Bun.spawnSync({
    cmd: ["sh", entrypoint, "start", "--api-home", legacy],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      COPILOT_API_HOME: current,
      COPILOT_API_GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe(legacy)
})
