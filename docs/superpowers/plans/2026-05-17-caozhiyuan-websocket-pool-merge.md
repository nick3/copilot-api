# caozhiyuan v1.10.4 WebSocket Pool Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `caozhiyuan` 分支新增的 v1.10.4 公共 WebSocket pool 改进合入 `all`，同时保留 `all` 的多账号、Admin-UI、provider 与 request-history 架构。

**Architecture:** 以 `all` 为主干，只吸收上游 Responses WebSocket pool 的并发安全策略：同一 pool key 有活跃请求时，新请求使用专用 WebSocket；没有活跃请求时复用池内连接。保留 `all` 已有的 `AccountContext`/`baseUrl` 注入、token fingerprint pool key、错误原因透传与 provider/多账号调用路径。

**Tech Stack:** TypeScript, Bun test runner, Git merge conflict resolution, Undici WebSocket mock tests.

---

## 功能层面吸收范围

1. **吸收 `v1.10.4` 版本号**
   - `package.json` 的 `version` 更新为 `1.10.4`。
   - 保留 `@nick3/copilot-api` 包名、`nick3/copilot-api` homepage/bugs/repository、Admin-UI 构建脚本与 `files: ["dist"]`。
   - 不吸收 `@jeffreycao/copilot-api` 元数据、`pages` 打包范围或 Electron build 脚本。

2. **吸收 Responses WebSocket pool 并发策略**
   - 不再用单条 pooled WebSocket 上的 lock 队列串行化同一 pool key 的并发请求。
   - 使用 `responsesWebSocketActiveRequests` 统计每个 pool key 的活跃请求数。
   - 当同一 pool key 已有活跃请求时，新请求创建 dedicated WebSocket，避免多个并发响应流共享同一连接造成消息归属风险。
   - 并发 dedicated WebSocket 完成后关闭；pooled WebSocket 在无活跃请求后继续进入 idle timer，可供后续顺序请求复用。
   - 在发送前检查 WebSocket 是否仍可用；不可用时移除 pool entry 并抛出明确错误。

3. **保留 `all` 已有能力**
   - `createResponses()` 继续通过 `account ?? accountFromState()` 得到 `ctx`。
   - `prepareResponsesWebSocketRequest()` 继续接收 `copilotToken: ctx.copilotToken`，pool key 使用当前账号 token fingerprint，而不是回退到单账号全局 `state.copilotToken`。
   - WebSocket URL 继续由 `copilotBaseUrl(ctx)` 传入，兼容 enterprise、多账号或自定义 Copilot API base URL。
   - 保留上次合并已吸收的 `createResponsesWebSocketError()`，确保 open/stream error 带底层原因与 `cause`。

## 当前冲突文件

- `package.json`
- `src/services/copilot/create-responses.ts`
- `tests/create-responses-websocket-pool.test.ts`

## 明确不处理范围

- 不恢复 Electron UI。
- 不删除或替换 Admin-UI。
- 不引入上游单账号状态模型。
- 不重写 request-history、provider、admin-api 或多账号账户选择逻辑。
- 不提交、打 tag 或 push；这些 Git 发布动作必须在用户另行明确确认后执行。

---

### Task 1: 解决 `package.json` 版本冲突

**Files:**
- Modify: `package.json:1-10`

- [ ] **Step 1: 保留 `all` 项目身份，只同步版本号**

将文件开头冲突解析为：

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@nick3/copilot-api",
  "version": "1.10.4",
  "description": "OpenAI and Anthropic-compatible gateway for GitHub Copilot or third-party providers.",
  "keywords": [
    "dashboard",
    "multi-provider",
    "github-copilot",
    "ai-gateway",
    "openai-compatible",
    "anthropic-compatible"
  ]
}
```

只替换冲突区；不要采用 `@jeffreycao/copilot-api`。

- [ ] **Step 2: 验证 package conflict 已消除**

Run:

```bash
git diff --name-only --diff-filter=U
```

Expected: 如果后续两个文件尚未处理，输出只包含：

```text
src/services/copilot/create-responses.ts
tests/create-responses-websocket-pool.test.ts
```

---

### Task 2: 先合并 WebSocket pool 测试覆盖

**Files:**
- Modify: `tests/create-responses-websocket-pool.test.ts`

- [ ] **Step 1: 解析 lazy-open 测试冲突**

在 `Responses websocket does not open until the stream is consumed` 测试中采用上游的新断言，删除旧 idle-timer override 冲突块：

```ts
  expect(MockWebSocket.instances).toHaveLength(0)

  const iterator = (response as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const firstChunk = iterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await iterator.next()
```

旧的“queued request clears stale idle timer”逻辑依赖 lock 队列；新策略改为并发 dedicated connection，该旧测试不再代表目标行为。

- [ ] **Step 2: 保留并发 dedicated connection 测试**

确保文件包含以下测试场景：

```ts
test("Responses websocket delayed concurrent streams still use dedicated connections", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )
  const secondResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const secondIterator = (secondResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondChunk = secondIterator.next()

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondChunk
  await secondIterator.next()

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})
```

关键点：直接调用 `createResponses()` 的测试都传入 `account`，以覆盖 `all` 的多账号路径，而不是隐式单账号全局状态路径。

- [ ] **Step 3: 保留错误原因透传测试**

确保以下两个既有测试仍存在且断言不变：

```ts
test("Responses websocket open failure includes the underlying reason", async () => {
  MockWebSocket.failOpen = true
  MockWebSocket.failOpenEvent = {
    error: new Error("tls handshake failed"),
  }

  let thrown: unknown = null

  try {
    await collectResponsesStream("request-1")
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(
    "Failed to create responses websocket: tls handshake failed",
  )
})

test("Responses websocket stream failure includes the underlying reason", async () => {
  MockWebSocket.autoComplete = false

  const streamPromise = collectResponsesStream("request-1")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitError({
    error: new Error("socket hang up"),
  })

  let thrown: unknown = null

  try {
    await streamPromise
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(
    "Responses websocket stream error: socket hang up",
  )
})
```

- [ ] **Step 4: 运行测试并确认当前实现仍失败**

Run:

```bash
bun test tests/create-responses-websocket-pool.test.ts
```

Expected: 在 `src/services/copilot/create-responses.ts` 冲突尚未解析前失败，失败原因应是 conflict marker 或 TypeScript parse error。

---

### Task 3: 合并 WebSocket pool 实现

**Files:**
- Modify: `src/services/copilot/create-responses.ts:569-856`

- [ ] **Step 1: 保留 `baseUrl` 参数并切换入口函数**

解析入口冲突为：

```ts
const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesStream => runResponsesWebSocketRequest(request, baseUrl)
```

- [ ] **Step 2: 使用 active-request target 选择逻辑**

将 `runResponsesWebSocketRequest()` 实现为：

```ts
const runResponsesWebSocketRequest = async function* (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesStream {
  const { entry, pooled } = getResponsesWebSocketRequestTarget(request, baseUrl)
  const release = acquireResponsesWebSocketEntry(request.poolKey, entry, pooled)

  try {
    const websocket = await getReadyResponsesWebSocket(
      request.poolKey,
      entry,
      pooled,
    )
    websocket.send(JSON.stringify(request.payload))

    for await (const data of createWebSocketMessageStream(websocket)) {
      const chunk = createResponsesWebSocketStreamChunk(data)
      yield chunk

      if (isTerminalResponsesStreamChunk(chunk)) {
        return
      }
    }

    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw new Error("Responses websocket ended without a terminal response")
  } catch (error) {
    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw toError(error)
  } finally {
    release()
  }
}
```

- [ ] **Step 3: 合并 request target 逻辑并保留 `baseUrl`**

```ts
const getResponsesWebSocketRequestTarget = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesWebSocketRequestTarget => {
  if (getResponsesWebSocketActiveRequestCount(request.poolKey) > 0) {
    return {
      entry: createResponsesWebSocketEntry(request, baseUrl),
      pooled: false,
    }
  }

  const existing = responsesWebSocketPool.get(request.poolKey)
  if (existing && !existing.closed) {
    clearResponsesWebSocketIdleTimer(existing)
    return {
      entry: existing,
      pooled: true,
    }
  }

  const entry = createResponsesWebSocketEntry(request, baseUrl)
  responsesWebSocketPool.set(request.poolKey, entry)
  return {
    entry,
    pooled: true,
  }
}
```

- [ ] **Step 4: 合并 entry 创建逻辑并保留 `buildResponsesWebSocketUrl(baseUrl)`**

```ts
const createResponsesWebSocketEntry = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesWebSocketEntry => {
  const entry: ResponsesWebSocketEntry = {
    closed: false,
    idleTimer: null,
    requestCount: 0,
    websocketPromise: openResponsesWebSocket({
      headers: request.headers,
      url: buildResponsesWebSocketUrl(baseUrl),
    }),
  }

  entry.websocketPromise
    .then((websocket) => {
      websocket.addEventListener("close", () => {
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
      websocket.addEventListener("error", () => {
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
    })
    .catch(() => {
      removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    })

  return entry
}
```

- [ ] **Step 5: 保留上游 active count helpers**

确认文件包含：

```ts
const getResponsesWebSocketActiveRequestCount = (poolKey: string): number =>
  responsesWebSocketActiveRequests.get(poolKey) ?? 0

const incrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  responsesWebSocketActiveRequests.set(
    poolKey,
    getResponsesWebSocketActiveRequestCount(poolKey) + 1,
  )
}

const decrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  const nextCount = getResponsesWebSocketActiveRequestCount(poolKey) - 1
  if (nextCount <= 0) {
    responsesWebSocketActiveRequests.delete(poolKey)
    return
  }

  responsesWebSocketActiveRequests.set(poolKey, nextCount)
}
```

- [ ] **Step 6: 运行 WebSocket pool 测试**

Run:

```bash
bun test tests/create-responses-websocket-pool.test.ts
```

Expected: PASS。

---

### Task 4: 定向回归与全量验证

**Files:**
- Test only.

- [ ] **Step 1: 运行 Responses 相关定向测试**

Run:

```bash
bun test tests/create-responses-websocket-pool.test.ts tests/create-responses.test.ts tests/responses-translation.test.ts tests/provider-model-alias.test.ts
```

Expected: PASS。

- [ ] **Step 2: 确认无未解决冲突**

Run:

```bash
git diff --name-only --diff-filter=U
```

Expected: no output。

- [ ] **Step 3: 运行项目级验证**

Run:

```bash
bun run typecheck && bun run lint && bun test && git diff --check
```

Expected:

```text
$ tsc
$ eslint --cache --ignore-pattern admin-ui
542 pass
0 fail
```

测试数量可能随当前分支变化略有不同，但必须是 `0 fail`。

---

## 最终合并策略摘要

- `package.json`：采用 `all` 元数据 + `caozhiyuan` 版本号 `1.10.4`。
- `create-responses.ts`：采用上游 active-request/dedicated-connection pool 逻辑，但所有 WebSocket URL 构造继续使用 `baseUrl` 参数，pool key 继续基于当前账号 token。
- `create-responses-websocket-pool.test.ts`：采用上游新增并发测试，删除与旧 lock 队列绑定的过时 idle-timer 测试片段，保留 `all` 的多账号 `account` 参数和错误原因透传测试。
- 发布动作：只有在用户明确确认后，才执行 merge commit、`v1.10.4` tag 与 push。
