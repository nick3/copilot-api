import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import "../src/lib/i18n"

import { JsonViewer } from "../src/components/json/json-viewer"

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
