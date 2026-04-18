import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { mergeToolResultForClaude } from "../src/routes/messages/preprocess"

test("matches pasted PDF documents to PDF file read tool_results", () => {
  const pdfPath1 = String.raw`/home/user/docs/report2024.pdf`
  const pdfPath2 = String.raw`/home/user/docs/datasheet.pdf`
  const pdfReadText1 = `PDF file read: ${pdfPath1} (276.1KB)`
  const pdfReadText2 = `PDF file read: ${pdfPath2} (943.8KB)`

  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-1",
            content: pdfReadText1,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-2",
            content: pdfReadText2,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-image-1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "image-data",
                },
              },
            ],
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
        ],
      },
    ],
  }

  mergeToolResultForClaude(payload)

  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-1",
        content: [
          {
            type: "text",
            text: pdfReadText1,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-2",
        content: [
          {
            type: "text",
            text: pdfReadText2,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-image-1",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "image-data",
            },
          },
        ],
      },
    ],
  })
})

test("preserves image and document order for PDF file read matches", () => {
  const pdfPath = String.raw`/home/user/docs/report2024.pdf`
  const pdfReadText = `PDF file read: ${pdfPath} (276.1KB)`

  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-1",
            content: pdfReadText,
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "image-data",
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data",
            },
            title: "report2024.pdf",
          },
        ],
      },
    ],
  }

  mergeToolResultForClaude(payload)

  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-1",
        content: [
          {
            type: "text",
            text: pdfReadText,
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "image-data",
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data",
            },
            title: "report2024.pdf",
          },
        ],
      },
    ],
  })
})

test("matches PDF documents in order before falling back for leftovers", () => {
  const pdfPath1 = String.raw`/home/user/docs/report2024.pdf`
  const pdfPath2 = String.raw`/home/user/docs/datasheet.pdf`
  const pdfReadText1 = `PDF file read: ${pdfPath1} (276.1KB)`
  const pdfReadText2 = `PDF file read: ${pdfPath2} (943.8KB)`

  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-1",
            content: pdfReadText1,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-2",
            content: pdfReadText2,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-3",
            },
            title: "appendix.pdf",
          },
        ],
      },
    ],
  }

  mergeToolResultForClaude(payload)

  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-1",
        content: [
          {
            type: "text",
            text: pdfReadText1,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-2",
        content: [
          {
            type: "text",
            text: pdfReadText2,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-3",
            },
            title: "appendix.pdf",
          },
        ],
      },
    ],
  })
})

test("excludes matched PDF tool results from leftover count matching", () => {
  const pdfPath1 = String.raw`/home/user/docs/report2024.pdf`
  const pdfPath2 = String.raw`/home/user/docs/datasheet.pdf`
  const pdfReadText1 = `PDF file read: ${pdfPath1} (276.1KB)`
  const pdfReadText2 = `PDF file read: ${pdfPath2} (943.8KB)`

  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-general-1",
            content: "general output",
          },
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-1",
            content: pdfReadText1,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-2",
            content: pdfReadText2,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "image-data",
            },
          },
        ],
      },
    ],
  }

  mergeToolResultForClaude(payload)

  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-general-1",
        content: [
          {
            type: "text",
            text: "general output",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "image-data",
            },
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-1",
        content: [
          {
            type: "text",
            text: pdfReadText1,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-1",
            },
            title: "report2024.pdf",
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-2",
        content: [
          {
            type: "text",
            text: pdfReadText2,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data-2",
            },
            title: "datasheet.pdf",
          },
        ],
      },
    ],
  })
})

test("skips PDF read matches when the tool result already contains a document", () => {
  const pdfPath = String.raw`/home/user/docs/report2024.pdf`
  const pdfReadText = `PDF file read: ${pdfPath} (276.1KB)`

  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-pdf-1",
            content: [
              {
                type: "text",
                text: pdfReadText,
              },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "existing-pdf-data",
                },
                title: "existing.pdf",
              },
            ],
          },
          {
            type: "tool_result",
            tool_use_id: "tool-general-1",
            content: "general output",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data",
            },
            title: "report2024.pdf",
          },
        ],
      },
    ],
  }

  mergeToolResultForClaude(payload)

  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-pdf-1",
        content: [
          {
            type: "text",
            text: pdfReadText,
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "existing-pdf-data",
            },
            title: "existing.pdf",
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-general-1",
        content: [
          {
            type: "text",
            text: "general output",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "pdf-data",
            },
            title: "report2024.pdf",
          },
        ],
      },
    ],
  })
})
