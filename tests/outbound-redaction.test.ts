import { expect, test } from "bun:test"

import { redactHeaders } from "~/lib/request-outbound"

test("redacts authorization, token, secret, cookie, x-api-key", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer x",
    authorization: "Bearer y",
    "x-github-token": "gh_z",
    "X-Api-Key": "secret",
    "my-custom-token": "t",
    "my-custom-secret": "s",
    cookie: "a=b",
    "set-cookie": "a=b",
    "proxy-authorization": "Basic foo",
    "x-request-id": "keep",
    "user-agent": "keep",
    "content-type": "keep",
  })

  for (const key of [
    "Authorization",
    "authorization",
    "x-github-token",
    "X-Api-Key",
    "my-custom-token",
    "my-custom-secret",
    "cookie",
    "set-cookie",
    "proxy-authorization",
  ]) {
    expect(redacted[key]).toBe("***")
  }

  expect(redacted["x-request-id"]).toBe("keep")
  expect(redacted["user-agent"]).toBe("keep")
  expect(redacted["content-type"]).toBe("keep")
})
