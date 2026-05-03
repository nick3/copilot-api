import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { copyLongStringValue, JsonViewer } from "~/components/json/json-viewer"
import { i18n } from "~/lib/i18n"

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

let writeText = mock(async () => {})
let successToasts: string[] = []
let errorToasts: Array<{ message: string; options?: unknown }> = []

function setGlobal(name: "navigator" | "document", value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  })
}

function createNotifier(): {
  success: (message: string) => void
  error: (message: string, options?: unknown) => void
} {
  return {
    success: (message: string) => {
      successToasts.push(message)
    },
    error: (message: string, options?: unknown) => {
      errorToasts.push({ message, options })
    },
  }
}

function restoreGlobal(name: "navigator" | "document", descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
    return
  }

  Reflect.deleteProperty(globalThis, name)
}

beforeEach(() => {
  i18n.changeLanguage("en-US")
  writeText = mock(async () => {})
  setGlobal("navigator", { clipboard: { writeText } })
  setGlobal("document", undefined)
  successToasts = []
  errorToasts = []
})

afterEach(() => {
  restoreGlobal("navigator", originalNavigator)
  restoreGlobal("document", originalDocument)
})

test("JsonViewer summarizes very long string values", () => {
  const longValue = "lookup-key-".repeat(500)

  const html = renderToStaticMarkup(
    <JsonViewer
      value={{ responses_item_owner_lookup_keys_json: longValue, next_field: "visible" }}
    />,
  )

  expect(html).toContain("responses_item_owner_lookup_keys_json")
  expect(html).toContain("Long string")
  expect(html).toContain("5,500 chars")
  expect(html).toContain("lookup-key-lookup-key")
  expect(html).toContain("View full")
  expect(html).toContain("Copy")
  expect(html).toContain("next_field")
  expect(html).not.toContain(longValue)
})

test("JsonViewer localizes the field name in long string context", () => {
  const longValue = "lookup-key-".repeat(500)

  const html = renderToStaticMarkup(
    <JsonViewer value={{ responses_item_owner_lookup_keys_json: longValue }} />,
  )

  expect(html).toContain("Long string: responses_item_owner_lookup_keys_json")
})

test("JsonViewer uses the current locale for long string context", () => {
  const longValue = "lookup-key-".repeat(500)
  i18n.changeLanguage("zh-CN")

  const html = renderToStaticMarkup(
    <JsonViewer value={{ responses_item_owner_lookup_keys_json: longValue }} />,
  )

  expect(html).toContain("长字符串：responses_item_owner_lookup_keys_json")
  expect(html).not.toContain("长字符串: responses_item_owner_lookup_keys_json")
})

test("JsonViewer keeps short string values inline", () => {
  const html = renderToStaticMarkup(
    <JsonViewer value={{ short_field: "short value" }} />,
  )

  expect(html).toContain("short_field")
  expect(html).toContain("&quot;short value&quot;")
  expect(html).not.toContain("Long string")
})

test("JsonViewer shows a search match hint for summarized long strings", () => {
  const longValue = `${"prefix-".repeat(400)}needle-${"suffix-".repeat(400)}`

  const html = renderToStaticMarkup(
    <JsonViewer value={{ long_field: longValue }} search="needle" />,
  )

  expect(html).toContain("Search matches inside this long value")
})

test("copyLongStringValue copies the full value and shows a JsonViewer success toast", async () => {
  const longValue = "lookup-key-".repeat(500)

  await copyLongStringValue(longValue, i18n.t, createNotifier())

  expect(writeText).toHaveBeenCalledWith(longValue)
  expect(successToasts).toEqual(["Long string copied"])
  expect(errorToasts).toEqual([])
})

test("copyLongStringValue shows a JsonViewer failure toast when copying fails", async () => {
  writeText = mock(async () => {
    throw new Error("Clipboard blocked")
  })
  setGlobal("navigator", { clipboard: { writeText } })

  await copyLongStringValue("lookup-key-", i18n.t, createNotifier())

  expect(writeText).toHaveBeenCalledWith("lookup-key-")
  expect(successToasts).toEqual([])
  expect(errorToasts).toHaveLength(1)
  expect(errorToasts[0]?.message).toBe("Failed to copy long string")
  expect(String((errorToasts[0]?.options as { description?: string }).description)).toContain(
    "Clipboard blocked",
  )
})
