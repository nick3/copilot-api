import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"

type TestConfig = Record<string, unknown>

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
  const original = await fs
    .readFile(PATHS.CONFIG_PATH, "utf8")
    .catch(() => null)

  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()

  try {
    await run()
  } finally {
    const restoreConfig =
      original === null ?
        fs.rm(PATHS.CONFIG_PATH, { force: true })
      : fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    await restoreConfig
    mergeConfigWithDefaults()
  }
}

test("GET /api/admin/dev-mode returns disabled state by default", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const response = await server.fetch(
      new Request("http://localhost/api/admin/dev-mode"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      enabled: false,
      capture4xx: false,
      capture5xx: false,
      captureOther: false,
    })
  })
})

test("POST /api/admin/dev-mode updates enabled and preserves capture4xx", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const postResponse = await server.fetch(
      new Request("http://localhost/api/admin/dev-mode", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    )

    expect(postResponse.status).toBe(200)
    expect(await postResponse.json()).toEqual({
      enabled: true,
      capture4xx: false,
      capture5xx: false,
      captureOther: false,
    })

    const getResponse = await server.fetch(
      new Request("http://localhost/api/admin/dev-mode"),
    )

    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toEqual({
      enabled: true,
      capture4xx: false,
      capture5xx: false,
      captureOther: false,
    })
  })
})
