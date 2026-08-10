import { ResponsesMessagesTranslationError } from "./messages-translation"

const CUSTOM_TOOL_INPUT_PREFIX_TOKENS = ["{", '"input"', ":", '"'] as const

type DecoderState = "prefix" | "input" | "suffix" | "done"
type EscapeState = "plain" | "escaped" | "unicode"

export class CustomToolInputStreamDecoder {
  private readonly inputParts = new Array<string>()
  private encodedInput = ""
  private escapeState: EscapeState = "plain"
  private failed = false
  private finished = false
  private offset = 0
  private prefixCharOffset = 0
  private prefixTokenOffset = 0
  private safeInputLength = 0
  private state: DecoderState = "prefix"
  private unicodeDigitsRemaining = 0

  append(partialJson: string): string {
    if (this.failed) return this.fail("decoder is already in a failed state")
    if (this.finished) return this.fail("data arrived after the input was done")

    const deltaParts = new Array<string>()
    for (const char of partialJson) {
      this.offset += char.length
      this.consume(char, deltaParts)
    }
    this.flushSafeInput(deltaParts)

    const delta = deltaParts.join("")
    if (delta) this.inputParts.push(delta)
    return delta
  }

  finish(): string {
    if (this.failed) return this.fail("decoder is already in a failed state")
    if (this.finished) return this.fail("input was already completed")
    if (
      this.state !== "done"
      || this.escapeState !== "plain"
      || this.encodedInput
    ) {
      return this.fail("input ended before the wrapper was complete")
    }

    this.finished = true
    return this.inputParts.join("")
  }

  private consume(char: string, deltaParts: Array<string>): void {
    if (this.state === "prefix") {
      const token = CUSTOM_TOOL_INPUT_PREFIX_TOKENS[this.prefixTokenOffset]
      if (this.prefixCharOffset === 0 && isJsonWhitespace(char)) return
      if (!token || char !== token[this.prefixCharOffset]) {
        return this.fail("unexpected custom tool input prefix")
      }
      this.prefixCharOffset += 1
      if (this.prefixCharOffset < token.length) return

      this.prefixTokenOffset += 1
      this.prefixCharOffset = 0
      if (this.prefixTokenOffset === CUSTOM_TOOL_INPUT_PREFIX_TOKENS.length) {
        this.state = "input"
      }
      return
    }

    if (this.state === "suffix") {
      if (isJsonWhitespace(char)) return
      if (char !== "}") return this.fail('expected "}" after the input string')
      this.state = "done"
      return
    }

    if (this.state === "done") {
      if (!isJsonWhitespace(char)) {
        return this.fail("unexpected data after the input wrapper")
      }
      return
    }

    if (this.escapeState === "unicode") {
      if (!/^[0-9A-Fa-f]$/u.test(char)) {
        return this.fail("invalid Unicode escape")
      }
      this.encodedInput += char
      this.unicodeDigitsRemaining -= 1
      if (this.unicodeDigitsRemaining === 0) {
        this.escapeState = "plain"
        this.safeInputLength = this.encodedInput.length
      }
      return
    }

    if (this.escapeState === "escaped") {
      if (!'"\\/bfnrtu'.includes(char)) {
        return this.fail("invalid JSON escape")
      }
      this.encodedInput += char
      if (char === "u") {
        this.escapeState = "unicode"
        this.unicodeDigitsRemaining = 4
      } else {
        this.escapeState = "plain"
        this.safeInputLength = this.encodedInput.length
      }
      return
    }

    if (char === "\\") {
      this.encodedInput += char
      this.escapeState = "escaped"
      return
    }
    if (char === '"') {
      this.flushSafeInput(deltaParts)
      this.state = "suffix"
      return
    }
    if (char.charCodeAt(0) < 0x20) {
      return this.fail("unescaped control character in custom tool input")
    }

    this.encodedInput += char
    this.safeInputLength = this.encodedInput.length
  }

  private flushSafeInput(deltaParts: Array<string>): void {
    if (this.safeInputLength === 0) return

    const encoded = this.encodedInput.slice(0, this.safeInputLength)
    const decoded = JSON.parse(`"${encoded}"`) as string

    if (decoded) deltaParts.push(decoded)
    this.encodedInput = this.encodedInput.slice(this.safeInputLength)
    this.safeInputLength = 0
  }

  private fail(reason: string): never {
    this.failed = true
    throw new ResponsesMessagesTranslationError(
      `Messages API returned invalid custom tool input JSON at offset ${this.offset}: ${reason}`,
      502,
    )
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n"
}
