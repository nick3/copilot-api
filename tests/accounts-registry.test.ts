import { expect, test } from "bun:test"
import fs from "node:fs/promises"

import {
  hasRegistry,
  loadRegistry,
  validateAccountId,
} from "../src/lib/accounts-registry"

type ReadFile = typeof fs.readFile

const withMockedReadFile = async <T>(
  impl: ReadFile,
  run: () => Promise<T>,
): Promise<T> => {
  const original = fs.readFile
  ;(fs as unknown as { readFile: ReadFile }).readFile = impl
  try {
    return await run()
  } finally {
    ;(fs as unknown as { readFile: ReadFile }).readFile = original
  }
}

test("validateAccountId follows GitHub login rules", () => {
  // valid
  expect(validateAccountId("octocat")).toBe(true)
  expect(validateAccountId("a-1")).toBe(true)
  expect(validateAccountId("A1")).toBe(true)

  // invalid
  expect(validateAccountId("a_b")).toBe(false)
  expect(validateAccountId("-abc")).toBe(false)
  expect(validateAccountId("abc-")).toBe(false)
  expect(validateAccountId("a--b")).toBe(false)
  expect(validateAccountId("a".repeat(40))).toBe(false)
})

test("loadRegistry returns empty registry on ENOENT", async () => {
  const registry = await withMockedReadFile(
    (() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    }) as unknown as ReadFile,
    loadRegistry,
  )

  expect(registry).toEqual({ version: 1, accounts: [] })
})

test("loadRegistry returns empty registry on empty file", async () => {
  const registry = await withMockedReadFile(
    (() => "   \n") as unknown as ReadFile,
    loadRegistry,
  )

  expect(registry).toEqual({ version: 1, accounts: [] })
})

test("loadRegistry throws on invalid JSON", async () => {
  try {
    await withMockedReadFile((() => "{") as unknown as ReadFile, loadRegistry)
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/Invalid accounts registry JSON at/)
  }
})

test("loadRegistry throws on schema validation errors", async () => {
  const content = JSON.stringify({
    version: 1,
    accounts: [{ id: "octocat", accountType: "foo", addedAt: 1 }],
  })

  try {
    await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/accounts\.0\.accountType/)
  }
})

test("loadRegistry throws on duplicate account ids", async () => {
  const content = JSON.stringify({
    version: 1,
    accounts: [
      { id: "octocat", accountType: "individual", addedAt: 1 },
      { id: "octocat", accountType: "business", addedAt: 2 },
    ],
  })

  try {
    await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/duplicate account id "octocat"/)
  }
})

test("hasRegistry fails fast on invalid registry JSON", async () => {
  try {
    await withMockedReadFile((() => "{") as unknown as ReadFile, hasRegistry)
    throw new Error("Expected hasRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/Invalid accounts registry JSON at/)
  }
})

test("addAccountToRegistry throws on duplicate account", async () => {
  const withMockedFs = async <T>(
    readImpl: ReadFile,
    writeImpl: typeof fs.writeFile,
    run: () => Promise<T>,
  ): Promise<T> => {
    const originalRead = fs.readFile
    const originalWrite = fs.writeFile
    ;(fs as unknown as { readFile: ReadFile }).readFile = readImpl
    ;(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile =
      writeImpl
    try {
      return await run()
    } finally {
      ;(fs as unknown as { readFile: ReadFile }).readFile = originalRead
      ;(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile =
        originalWrite
    }
  }

  const content = JSON.stringify({
    version: 1,
    accounts: [{ id: "octocat", accountType: "individual", addedAt: 1 }],
  })

  try {
    await withMockedFs(
      (() => content) as unknown as ReadFile,
      (() => Promise.resolve()) as unknown as typeof fs.writeFile,
      async () => {
        const { addAccountToRegistry } = await import(
          "../src/lib/accounts-registry"
        )
        await addAccountToRegistry({
          id: "octocat",
          accountType: "business",
          addedAt: Date.now(),
        })
      },
    )
    throw new Error("Expected addAccountToRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/Account already exists: octocat/)
  }
})

test("validateAccountId rejects empty string", () => {
  expect(validateAccountId("")).toBe(false)
})

test("validateAccountId rejects 40+ character strings", () => {
  expect(validateAccountId("a".repeat(39))).toBe(true)
  expect(validateAccountId("a".repeat(40))).toBe(false)
})

test("validateAccountId rejects underscores", () => {
  expect(validateAccountId("user_name")).toBe(false)
})

test("validateAccountId allows mixed case", () => {
  expect(validateAccountId("GitHubUser123")).toBe(true)
})

test("validateAccountId rejects special characters", () => {
  expect(validateAccountId("user@name")).toBe(false)
  expect(validateAccountId("user.name")).toBe(false)
  expect(validateAccountId("user#name")).toBe(false)
})
