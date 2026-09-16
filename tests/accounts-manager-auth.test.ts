import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import {
  isAuthSnapshotCurrent,
  takeAuthSnapshot,
  toAccountContextFromSnapshot,
} from "../src/lib/accounts-manager-auth"

test("toAccountContextFromSnapshot preserves account-scoped identity fields", () => {
  const account: AccountRuntime = {
    id: "octocat",
    accountLogin: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    copilotApiUrl: "https://copilot.example.com",
    vsCodeVersion: "1.0.0",
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  }

  const snapshot = takeAuthSnapshot(account)

  expect(
    toAccountContextFromSnapshot(account, snapshot, "copilot_test"),
  ).toEqual({
    accountLogin: "octocat",
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    copilotApiUrl: "https://copilot.example.com",
    accountType: "individual",
    vsCodeVersion: "1.0.0",
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  })
})

test("auth snapshot remains current when only the session ID rotates", () => {
  const account: AccountRuntime = {
    id: "octocat",
    accountLogin: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    clientSessionId: "session-1",
  }

  const snapshot = takeAuthSnapshot(account)
  account.clientSessionId = "session-2"

  expect(isAuthSnapshotCurrent(account, snapshot)).toBe(true)
})

import {
  applyCopilotTokenIfCurrent,
  applyTokenRefreshSuccessIfCurrent,
  applyQuotaRefreshSuccessIfCurrent,
} from "../src/lib/accounts-manager-auth"

const endpointAccount = (id: string): AccountRuntime => ({
  id,
  githubToken: `github-${id}`,
  accountType: "business",
  addedAt: 0,
})
const premiumQuota = {
  quota_remaining: 290,
  entitlement: 300,
  remaining: 290,
  unlimited: false,
  overage_permitted: false,
  overage_count: 0,
  percent_remaining: 96,
  quota_id: "premium_interactions",
}

test("token endpoints remain isolated across accounts and override usage hosts", () => {
  const a = endpointAccount("a")
  const b = endpointAccount("b")
  for (const account of [a, b]) {
    const snapshot = takeAuthSnapshot(account)
    const tokenHost = `https://${account.id}.enterprise.example`
    expect(
      applyCopilotTokenIfCurrent(
        account,
        snapshot,
        `token-${account.id}`,
        tokenHost,
      ),
    ).toBe(true)
    applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
      premium: premiumQuota,
      copilotApiUrl: "https://business.example",
    })
    expect(account.copilotApiUrl).toBe(tokenHost)
    expect(toAccountContextFromSnapshot(account, snapshot).copilotApiUrl).toBe(
      tokenHost,
    )
  }
  expect(a.copilotApiUrl).not.toBe(b.copilotApiUrl)
})

test("a refreshed token without an endpoint falls back to the same account's usage host", () => {
  const account = endpointAccount("a")
  const snapshot = takeAuthSnapshot(account)
  applyCopilotTokenIfCurrent(
    account,
    snapshot,
    "token-1",
    "https://enterprise.example",
  )
  applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
    premium: premiumQuota,
    copilotApiUrl: "https://business.example",
  })
  expect(applyTokenRefreshSuccessIfCurrent(account, snapshot, "token-2")).toBe(
    true,
  )
  expect(account.copilotApiUrl).toBe("https://business.example")
  expect(account.copilotTokenApiUrl).toBeUndefined()
  expect(account.copilotToken).toBe("token-2")
})

test("rotation clears a stale token endpoint when there is no usage fallback", () => {
  const account = endpointAccount("a")
  const snapshot = takeAuthSnapshot(account)
  applyCopilotTokenIfCurrent(
    account,
    snapshot,
    "token-1",
    "https://enterprise.example",
  )
  applyCopilotTokenIfCurrent(account, snapshot, "token-2")
  expect(account.copilotApiUrl).toBeUndefined()
})

test("stale token and quota responses cannot overwrite new authentication", () => {
  const account = endpointAccount("a")
  const old = takeAuthSnapshot(account)
  account.githubToken = "new-identity"
  const current = takeAuthSnapshot(account)
  applyCopilotTokenIfCurrent(
    account,
    current,
    "new-token",
    "https://new.example",
  )
  expect(
    applyCopilotTokenIfCurrent(account, old, "stale", "https://stale.example"),
  ).toBe(false)
  expect(
    applyTokenRefreshSuccessIfCurrent(
      account,
      old,
      "stale",
      "https://stale.example",
    ),
  ).toBe(false)
  expect(
    applyQuotaRefreshSuccessIfCurrent(account, old, {
      premium: premiumQuota,
      copilotApiUrl: "https://stale.example",
    }),
  ).toBe(false)
  expect(account.copilotApiUrl).toBe("https://new.example")
  expect(account.copilotToken).toBe("new-token")
})
