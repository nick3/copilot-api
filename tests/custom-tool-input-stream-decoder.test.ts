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

  test("ignores extra properties after the input string", () => {
    const input = 'quote: " brace: } slash: \\'
    const wrapped = JSON.stringify({
      input,
      timeout_ms: 1000,
      nested: { a: [1, true, null, { b: "]}" }], note: 'x"y\\z' },
    })

    for (let split = 0; split <= wrapped.length; split += 1) {
      const result = decodeChunks([
        wrapped.slice(0, split),
        wrapped.slice(split),
      ])
      expect(result.deltas.join("")).toBe(input)
      expect(result.input).toBe(input)
    }
  })

  test("accepts whitespace around extra properties", () => {
    const result = decodeChunks([
      '{"input":"do work"',
      ' , "timeout_ms": 120000 , "flag": false }',
    ])

    expect(result.deltas).toEqual(["do work"])
    expect(result.input).toBe("do work")
  })

  test("rejects an unclosed wrapper after extra properties", () => {
    const decoder = new CustomToolInputStreamDecoder()
    decoder.append('{"input":"x", "timeout_ms": 1000')
    expect(() => decoder.finish()).toThrow("Invalid tool input JSON")
  })

  test("rejects data after the wrapper closes behind extra properties", () => {
    const decoder = new CustomToolInputStreamDecoder()
    expect(() => decoder.append('{"input":"x", "a": [1, {"b": 2}]}x')).toThrow(
      "Invalid tool input JSON",
    )
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
    expect(() => decoder.append(value)).toThrow("Invalid tool input JSON")
  })

  test("rejects incomplete and repeated completion", () => {
    const incomplete = new CustomToolInputStreamDecoder()
    incomplete.append('{"input":"value"')
    expect(() => incomplete.finish()).toThrow("Invalid tool input JSON")

    const complete = new CustomToolInputStreamDecoder()
    complete.append('{"input":"value"}')
    expect(complete.finish()).toBe("value")
    expect(() => complete.finish()).toThrow("Invalid tool input JSON")
  })

  test("rejects data after completion and calls after failure", () => {
    const complete = new CustomToolInputStreamDecoder()
    complete.append('{"input":"value"}')
    complete.finish()
    expect(() => complete.append(" ")).toThrow("Invalid tool input JSON")

    const failed = new CustomToolInputStreamDecoder()
    expect(() => failed.append("{")).not.toThrow()
    expect(() => failed.append("x")).toThrow("Invalid tool input JSON")
    expect(() => failed.append("")).toThrow("Invalid tool input JSON")
    expect(() => failed.finish()).toThrow("Invalid tool input JSON")
  })
})
