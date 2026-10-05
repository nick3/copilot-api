import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Copilot aliases select real accounts across model ID formats, SSE, affinity and Responses adaptation", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-alias-routing-"),
  )
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        'await import("./tests/fixtures/copilot-alias-routing.ts"); process.exit(0)',
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, COPILOT_API_HOME: directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect({ exit, error: exit === 0 ? "" : stderr }).toEqual({
      exit: 0,
      error: "",
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
