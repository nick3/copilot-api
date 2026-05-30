import consola from "consola"

// Cross-layer side-channel between the Codex-facing Responses websocket bridge
// (WS #1, `src/routes/responses/websocket.ts`) and the upstream GitHub Responses
// websocket pool (WS #2, `src/services/copilot/create-responses.ts`).
//
// The pool reaps an idle upstream connection after
// `RESPONSES_WEBSOCKET_IDLE_TIMEOUT_MS`. Once that happens the conversation state
// GitHub keyed to that connection (referenced by `previous_response_id`) is gone,
// so the next incremental turn Codex sends over the still-open bridge socket would
// reference a `previous_response_id` the fresh upstream connection has never seen.
// Codex cannot recover from that quickly (it silently waits out its 5 minute
// `stream_idle_timeout` before retrying).
//
// To force a clean, immediate recovery we close the bridge socket (WS #1) whenever
// its upstream connection is dropped while idle. Codex then notices its cached
// session is closed at the start of the next turn and transparently rebuilds a
// fresh full-context request (no `previous_response_id`).
//
// The bridge cannot be looked up by `sessionId` because the pool key derives that
// value via `getUUID(...)` in the handler, which the bridge layer does not cheaply
// reproduce. Instead the bridge mints a `bridgeId`, registers a closer here, and
// threads the id down to the pool entry so the pool can close the exact socket.

type BridgeCloser = () => void

const bridgeClosers = new Map<string, BridgeCloser>()

export const registerResponsesBridge = (
  bridgeId: string,
  closer: BridgeCloser,
): void => {
  bridgeClosers.set(bridgeId, closer)
}

export const unregisterResponsesBridge = (bridgeId: string): void => {
  bridgeClosers.delete(bridgeId)
}

// Close the bridge socket associated with `bridgeId`, if one is still registered.
// Idempotent and safe to call for unknown ids: the bridge may have already closed
// (e.g. Codex disconnected) and unregistered itself.
export const closeResponsesBridge = (bridgeId: string): void => {
  const closer = bridgeClosers.get(bridgeId)
  if (!closer) {
    return
  }

  try {
    closer()
  } catch (error) {
    consola.warn("Failed to close Responses websocket bridge:", error)
  }
}
