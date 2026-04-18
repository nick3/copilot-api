export type SSEEvent = {
  event?: string
  data: string
}

export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (!signal?.aborted) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf("\n\n")
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      let event: string | undefined
      const dataLines: Array<string> = []
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length > 0) onEvent({ event, data: dataLines.join("\n") })
      boundary = buffer.indexOf("\n\n")
    }
  }
  buffer += decoder.decode()

  if (buffer.trim()) {
    let event: string | undefined
    const dataLines: Array<string> = []
    for (const line of buffer.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length > 0) onEvent({ event, data: dataLines.join("\n") })
  }
}
