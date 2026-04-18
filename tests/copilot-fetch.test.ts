import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import * as devMode from "~/lib/dev-mode"
import * as outbound from "~/lib/request-outbound"

const insertSpy = mock(() => {})

let devModeSpy: ReturnType<typeof spyOn<typeof devMode, "isCapture4xxEnabled">>
let outboundSpy: ReturnType<
  typeof spyOn<typeof outbound, "getRequestOutboundStore">
>

beforeEach(() => {
  insertSpy.mockClear()
  devModeSpy = spyOn(devMode, "isCapture4xxEnabled").mockReturnValue(true)
  outboundSpy = spyOn(outbound, "getRequestOutboundStore").mockReturnValue({
    insert: insertSpy,
    getByRequestId: () => null,
    cleanupOrphans: () => {},
    meta: () => ({
      dbPath: "",
      userVersion: 0,
      retentionDays: 35,
      maxRows: 200000,
    }),
  } as unknown as ReturnType<typeof outbound.getRequestOutboundStore>)
})

afterEach(() => {
  devModeSpy.mockRestore()
  outboundSpy.mockRestore()
})

function setFetchResponse(response: Response): void {
  // @ts-expect-error test mock only implements fetch call signature
  globalThis.fetch = mock(() => Promise.resolve(response))
}

test("2xx response is not captured", async () => {
  setFetchResponse(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  const response = await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-2xx", callSite: "test" },
  )

  expect(response.status).toBe(200)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).not.toHaveBeenCalled()
})

test("4xx JSON response is captured", async () => {
  setFetchResponse(
    new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  const response = await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: {
        authorization: "Bearer SECRET",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-4xx", callSite: "test" },
  )

  expect(response.status).toBe(400)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).toHaveBeenCalledTimes(1)
  expect(insertSpy).toHaveBeenCalledWith({
    requestId: "req-4xx",
    httpStatus: 400,
    upstreamUrl: "https://example.com/v1/messages",
    upstreamMethod: "POST",
    requestHeaders: {
      authorization: "Bearer SECRET",
      "content-type": "application/json",
    },
    requestBody: JSON.stringify({ hello: "world" }),
    requestBodyKind: "json",
    responseStatus: 400,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ error: "bad request" }),
    responseBodyKind: "json",
  })
})

test("5xx response is NOT captured", async () => {
  setFetchResponse(
    new Response("bad gateway", {
      status: 502,
      headers: { "content-type": "text/plain" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  const response = await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-5xx", callSite: "test" },
  )

  expect(response.status).toBe(502)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).not.toHaveBeenCalled()
})

test("capturable:false disables capture for 4xx", async () => {
  setFetchResponse(
    new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-no-capture", capturable: false, callSite: "test" },
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).not.toHaveBeenCalled()
})

test("capture4xx config=false disables capture", async () => {
  devModeSpy.mockReturnValue(false)

  setFetchResponse(
    new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-config-off", callSite: "test" },
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).not.toHaveBeenCalled()
})

test("missing requestId disables capture", async () => {
  setFetchResponse(
    new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { callSite: "test" },
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).not.toHaveBeenCalled()
})

test("tee() does not corrupt the caller-facing body", async () => {
  setFetchResponse(
    new Response(JSON.stringify({ error: "full body preserved" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

  const { copilotFetch } = await import("~/services/copilot/copilot-fetch")

  const response = await copilotFetch(
    "https://example.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
    { requestId: "req-tee", callSite: "test" },
  )

  expect(await response.text()).toBe(
    JSON.stringify({ error: "full body preserved" }),
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(insertSpy).toHaveBeenCalledTimes(1)
  expect(insertSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      responseBody: JSON.stringify({ error: "full body preserved" }),
    }),
  )
})
