import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

export async function writeSSEIfConnected(
  stream: SSEStreamingApi,
  message: SSEMessage,
): Promise<boolean> {
  if (stream.aborted) return false

  try {
    await stream.writeSSE(message)
    return true
  } catch (error) {
    if (stream.aborted) return false
    throw error
  }
}
