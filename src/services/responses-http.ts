import { events, type ServerSentEventMessage } from "fetch-event-stream"

export const createResponsesHttpEventStream = async function* (
  response: Response,
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  const responseBody = response.body
  if (!responseBody) return

  const reader =
    responseBody.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const readerBackedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()
      if (result.done) {
        controller.close()
        return
      }

      controller.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  try {
    yield* events(new Response(readerBackedBody))
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The managed response may already have failed or been cancelled.
    } finally {
      reader.releaseLock()
    }
  }
}
