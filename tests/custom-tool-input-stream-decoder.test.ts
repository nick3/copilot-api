import { describe, expect, test } from "bun:test"

import { CustomToolInputStreamDecoder } from "~/routes/responses/custom-tool-input-stream-decoder"

const decodeChunks = (
  chunks: Array<string>,
): {
  deltas: Array<string>
  input: string
} => {
  const decoder = new CustomToolInputStreamDecoder()
  const deltas = chunks.map((chunk) => decoder.append(chunk)).filter(Boolean)
  return { deltas, input: decoder.finish() }
}

describe("CustomToolInputStreamDecoder", () => {
  test("decodes every two-chunk split of a custom input wrapper", () => {
    const input = 'line 1\nquote: "} slash: \\ end'
    const wrapped = JSON.stringify({ input })

    for (let split = 0; split <= wrapped.length; split += 1) {
      const result = decodeChunks([
        wrapped.slice(0, split),
        wrapped.slice(split),
      ])
      expect(result.deltas.join("")).toBe(input)
      expect(result.input).toBe(input)
    }
  })

  test("accepts JSON whitespace around streamed wrapper prefix tokens", () => {
    const result = decodeChunks([
      " \n",
      "{",
      "\t",
      '"',
      "input",
      '"',
      "\r",
      ": ",
      '"',
      "const",
      " results",
      " =",
      " []",
      '"',
      " \n",
      "}",
      "\t",
    ])

    expect(result.deltas).toEqual(["const", " results", " =", " []"])
    expect(result.input).toBe("const results = []")
  })

  test("keeps an escaped quote and brace inside the streamed input", () => {
    const decoder = new CustomToolInputStreamDecoder()

    expect(decoder.append('{"input":"before \\"')).toBe('before "')
    expect(decoder.append('} after"')).toBe("} after")
    expect(decoder.append("}")).toBe("")
    expect(decoder.finish()).toBe('before "} after')
  })

  test("decodes escaped Unicode and a suffix split across chunks", () => {
    const result = decodeChunks(['{"input":"\\u4e2d\\uD83D', '\\uDE00"', "}"])

    expect(result.deltas.join("")).toBe("\u4e2d\ud83d\ude00")
    expect(result.input).toBe("\u4e2d\ud83d\ude00")
  })

  test("supports empty input and JSON whitespace before the suffix", () => {
    expect(decodeChunks(['{"input":""', " \n}\t"]).input).toBe("")
  })

  test.each([
    ["missing object", '"input":"x"}'],
    ["wrong prefix", '{"value":"x"}'],
    ["invalid separator", '{"input"="x"}'],
    ["non-string input", '{"input":42}'],
    ["invalid escape", '{"input":"\\q"}'],
    ["invalid Unicode escape", '{"input":"\\u12x4"}'],
    ["unescaped control character", '{"input":"line\n"}'],
    ["invalid suffix", '{"input":"x"]'],
    ["trailing data", '{"input":"x"}x'],
  ])("rejects %s", (_name, value) => {
    const decoder = new CustomToolInputStreamDecoder()
    expect(() => decoder.append(value)).toThrow(
      "Messages API returned invalid custom tool input JSON",
    )
  })

  test("rejects incomplete and repeated completion", () => {
    const incomplete = new CustomToolInputStreamDecoder()
    incomplete.append('{"input":"value"')
    expect(() => incomplete.finish()).toThrow("wrapper was complete")

    const complete = new CustomToolInputStreamDecoder()
    complete.append('{"input":"value"}')
    expect(complete.finish()).toBe("value")
    expect(() => complete.finish()).toThrow("already completed")
  })

  test("rejects data after completion and calls after failure", () => {
    const complete = new CustomToolInputStreamDecoder()
    complete.append('{"input":"value"}')
    complete.finish()
    expect(() => complete.append(" ")).toThrow("after the input was done")

    const failed = new CustomToolInputStreamDecoder()
    expect(() => failed.append("{")).not.toThrow()
    expect(() => failed.append("x")).toThrow("unexpected custom tool input")
    expect(() => failed.append("")).toThrow("failed state")
    expect(() => failed.finish()).toThrow("failed state")
  })
})
