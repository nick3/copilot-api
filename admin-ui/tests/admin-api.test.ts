import { afterEach, expect, mock, test } from "bun:test"

import { getAdminAggregatedModels } from "../src/lib/admin-api"

const originalFetch = globalThis.fetch

const fetchMock = mock((...args: Parameters<typeof fetch>) => {
  void args
  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: "gpt-5-mini",
          object: "model",
          type: "model",
          created: 0,
          created_at: "1970-01-01T00:00:00.000Z",
          owned_by: "openai",
          display_name: "gpt-5-mini",
          claude_model_id: "gpt-5-mini",
        },
      ],
      has_more: false,
    }),
  )
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  fetchMock.mockClear()
})

test("getAdminAggregatedModels calls the Admin aggregated models alias", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await getAdminAggregatedModels()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/models/aggregated")
  expect(response.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
})
