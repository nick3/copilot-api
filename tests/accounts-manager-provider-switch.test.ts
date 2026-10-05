import { afterEach, expect, mock, test } from "bun:test"
import type { AccountsManager } from "../src/lib/accounts-manager"
import type { AccountRuntime } from "../src/lib/types/account"
import { makeModel, setupManager } from "./accounts-manager-test-helpers"

const originalFetch = globalThis.fetch
const managers: Array<AccountsManager> = []
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const manager of managers.splice(0)) manager.shutdown()
})
function fixture() {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: 0,
    githubToken: "test-gh",
    copilotToken: "old-token",
    models: { object: "list", data: [makeModel({ id: "old-model" })] },
  }
  const manager = setupManager([account])
  managers.push(manager)
  // Client identity persistence is independent of lifecycle transitions.
  const internals = manager as unknown as {
    applyAccountIdentity: (value: AccountRuntime) => Promise<void>
    refreshModels: (value: AccountRuntime) => Promise<void>
  }
  internals.applyAccountIdentity = () => Promise.resolve()
  return { manager, account, internals }
}
function responseFor(url: string): Response {
  if (url.endsWith("/token"))
    return Response.json({
      token: "new-token",
      refresh_in: 3600,
      endpoints: { api: "https://copilot.test" },
    })
  if (url.endsWith("/models"))
    return Response.json({
      object: "list",
      data: [makeModel({ id: "new-model" })],
    })
  return Response.json({
    quota_snapshots: {
      premium_interactions: {
        entitlement: 100,
        remaining: 100,
        unlimited: true,
      },
    },
    endpoints: { api: "https://copilot.test" },
    token_based_billing: true,
  })
}
test("disabling retains accounts, pauses routing, and re-enabling refreshes each account", async () => {
  const { manager, account } = fixture()
  account.failed = true
  account.failureReason = "Previous initialization failure"
  const fetchMock = mock((input: string | URL | Request) =>
    Promise.resolve(
      responseFor(input instanceof Request ? input.url : input.toString()),
    ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await manager.setCopilotEnabled(false)
  expect(manager.getAccountCount()).toBe(1)
  expect(manager.getModelsForRouting()).toEqual([])
  expect(fetchMock).not.toHaveBeenCalled()
  await manager.setCopilotEnabled(true)
  expect(account.copilotToken).toBe("new-token")
  expect(manager.getModelsForRouting().map((model) => model.id)).toEqual([
    "new-model",
  ])
  const calls = fetchMock.mock.calls.length
  await manager.setCopilotEnabled(true)
  expect(fetchMock).toHaveBeenCalledTimes(calls)
})
test("failed activation can be retried without toggling the switch again", async () => {
  const { manager, account } = fixture()
  const fetchMock = mock((input: string | URL | Request) =>
    Promise.resolve(
      responseFor(input instanceof Request ? input.url : input.toString()),
    ),
  )
  fetchMock.mockResolvedValueOnce(
    new Response("temporarily unavailable", { status: 503 }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await manager.setCopilotEnabled(false)
  const error: unknown = await manager
    .setCopilotEnabled(true)
    .catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  await manager.setCopilotEnabled(true)
  expect(account.copilotToken).toBe("new-token")
})
test("an in-flight token result cannot reactivate a disabled account pool", async () => {
  const { manager, account } = fixture()
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  globalThis.fetch = mock(() => {
    started.resolve()
    return pending.promise
  }) as unknown as typeof fetch
  await manager.setCopilotEnabled(false)
  const activating = manager.setCopilotEnabled(true)
  await started.promise
  await manager.setCopilotEnabled(false)
  pending.resolve(responseFor("https://github.test/token"))
  await activating
  expect(account.copilotToken).toBe("old-token")
  expect(manager.getModelsForRouting()).toEqual([])
})
test("stale model and unauthorized quota responses cannot mutate a disabled pool", async () => {
  const { manager, account, internals } = fixture()
  const modelResult = Promise.withResolvers<Response>()
  const quotaResult = Promise.withResolvers<Response>()
  globalThis.fetch = mock((input: string | URL | Request) =>
    (
      (input instanceof Request ? input.url : input.toString()).endsWith(
        "/models",
      )
    ) ?
      modelResult.promise
    : quotaResult.promise,
  ) as unknown as typeof fetch
  const models = internals.refreshModels(account)
  const quota = manager.refreshQuota(account)
  await manager.setCopilotEnabled(false)
  modelResult.resolve(responseFor("https://copilot.test/models"))
  quotaResult.resolve(new Response("unauthorized", { status: 401 }))
  await Promise.all([models, quota])
  expect(account.models?.data[0].id).toBe("old-model")
  expect(account.failed).not.toBe(true)
})
