import { expect, test } from "bun:test"

import {
  buildAdaptiveNumberFormatCandidates,
  buildAdaptiveNumberPairCandidates,
  pickAdaptiveNumberFormatCandidate,
  pickAdaptiveNumberPairCandidate,
  resolveAdaptiveNumberFormatCandidate,
  resolveAdaptiveNumberPairCandidate,
} from "../src/lib/format"

test("buildAdaptiveNumberFormatCandidates returns full and compact fallbacks for large values", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(1001802257)

  expect(candidates.map((candidate) => candidate.text)).toEqual([
    "1,001,802,257",
    "1.0B",
    "1B",
  ])
})

test("buildAdaptiveNumberFormatCandidates keeps exact precision for smaller values", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(123.4, 1)

  expect(candidates.map((candidate) => candidate.text)).toEqual(["123.4"])
})

test("buildAdaptiveNumberFormatCandidates adds compact fallbacks when rounded display crosses 1000", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(999.95, 1)

  expect(candidates.map((candidate) => candidate.text)).toEqual([
    "1,000.0",
    "1.0K",
    "1K",
  ])
})

test("buildAdaptiveNumberPairCandidates degrades the primary value before the secondary value", () => {
  const candidates = buildAdaptiveNumberPairCandidates(1001802257, 1001802257)

  expect(candidates[0]?.text).toBe("1,001,802,257 / 1,001,802,257")
  expect(candidates[1]?.text).toBe("1.0B / 1,001,802,257")
  expect(candidates[candidates.length - 1]?.text).toBe("1B / 1B")
})

test("pickAdaptiveNumberFormatCandidate returns the first candidate that fits", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(1001802257)

  const selected = pickAdaptiveNumberFormatCandidate(candidates, (candidate) => candidate.text.length <= 4)

  expect(selected.text).toBe("1.0B")
})

test("pickAdaptiveNumberFormatCandidate falls back to the shortest candidate when none fit", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(1001802257)

  const selected = pickAdaptiveNumberFormatCandidate(candidates, () => false)

  expect(selected.text).toBe("1B")
})

test("pickAdaptiveNumberPairCandidate returns the first pair that fits", () => {
  const candidates = buildAdaptiveNumberPairCandidates(1001802257, 1001802257)

  const selected = pickAdaptiveNumberPairCandidate(candidates, (candidate) => candidate.text.length <= 9)

  expect(selected.text).toBe("1B / 1.0B")
})

test("pickAdaptiveNumberPairCandidate falls back to the shortest pair when none fit", () => {
  const candidates = buildAdaptiveNumberPairCandidates(1001802257, 1001802257)

  const selected = pickAdaptiveNumberPairCandidate(candidates, () => false)

  expect(selected.text).toBe("1B / 1B")
})

test("resolveAdaptiveNumberFormatCandidate reuses the current candidate when it still exists", () => {
  const candidates = buildAdaptiveNumberFormatCandidates(1001802257)
  const currentCandidate = candidates[1]

  expect(
    resolveAdaptiveNumberFormatCandidate(candidates, currentCandidate),
  ).toEqual(currentCandidate)
})

test("resolveAdaptiveNumberFormatCandidate falls back to the shortest candidate when the current one is stale", () => {
  const currentCandidate = buildAdaptiveNumberFormatCandidates(1001802257)[0]
  const nextCandidates = buildAdaptiveNumberFormatCandidates(1000)

  expect(
    resolveAdaptiveNumberFormatCandidate(nextCandidates, currentCandidate),
  ).toEqual(nextCandidates[nextCandidates.length - 1])
})

test("resolveAdaptiveNumberPairCandidate falls back to the shortest pair when the current pair is stale", () => {
  const currentCandidate = buildAdaptiveNumberPairCandidates(1001802257, 1001802257)[0]
  const nextCandidates = buildAdaptiveNumberPairCandidates(1000, 1000)

  expect(
    resolveAdaptiveNumberPairCandidate(nextCandidates, currentCandidate),
  ).toEqual(nextCandidates[nextCandidates.length - 1])
})
