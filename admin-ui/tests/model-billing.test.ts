import { expect, test } from "bun:test"

import {
  getModelAiCreditsPriceTiers,
  hasAdminModelTokenPrices,
} from "../src/lib/model-billing"

test("normalizes tiered AI Credit prices per million tokens", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1_000_000,
      default: {
        cache_price: 50,
        context_max: 200_000,
        input_price: 500,
        output_price: 2_500,
      },
    }),
  ).toEqual([
    {
      key: "default",
      cache: 50,
      contextMax: 200_000,
      input: 500,
      output: 2_500,
    },
  ])
})

test("normalizes and preserves distinct long-context pricing", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1_000_000,
      default: {
        cache_price: 20,
        context_max: 200_000,
        input_price: 200,
        output_price: 1_200,
      },
      long_context: {
        cache_price: 40,
        context_max: 936_000,
        input_price: 400,
        output_price: 1_800,
      },
    }),
  ).toEqual([
    {
      key: "default",
      cache: 20,
      contextMax: 200_000,
      input: 200,
      output: 1_200,
    },
    {
      key: "long_context",
      cache: 40,
      contextMax: 936_000,
      input: 400,
      output: 1_800,
    },
  ])
})

test("collapses long-context pricing when displayed prices are identical", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1_000_000,
      default: {
        cache_price: 50,
        context_max: 200_000,
        input_price: 500,
        output_price: 2_500,
      },
      long_context: {
        cache_price: 50,
        context_max: 936_000,
        input_price: 500,
        output_price: 2_500,
      },
    }),
  ).toHaveLength(1)
})

test("normalizes non-million batches and legacy flat nano prices", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 500_000,
      default: {
        cache_price: 25,
        input_price: 250,
        output_price: 1_250,
      },
    }),
  ).toEqual([
    {
      key: "default",
      cache: 50,
      contextMax: undefined,
      input: 500,
      output: 2_500,
    },
  ])

  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1_000_000,
      cache_price: 50_000_000_000,
      input_price: 500_000_000_000,
      output_price: 2_500_000_000_000,
    }),
  ).toEqual([
    {
      key: "default",
      cache: 50,
      contextMax: undefined,
      input: 500,
      output: 2_500,
    },
  ])

  expect(
    getModelAiCreditsPriceTiers({
      cache_price: 50_000_000_000,
      input_price: 500_000_000_000,
      output_price: 2_500_000_000_000,
    }),
  ).toEqual([
    {
      key: "default",
      cache: 50,
      contextMax: undefined,
      input: 500,
      output: 2_500,
    },
  ])
})

test("falls back to legacy prices when nested default has metadata only", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1_000_000,
      cache_price: 50_000_000_000,
      input_price: 500_000_000_000,
      output_price: 2_500_000_000_000,
      default: {
        context_max: 200_000,
      },
    }),
  ).toEqual([
    {
      key: "default",
      cache: 50,
      contextMax: 200_000,
      input: 500,
      output: 2_500,
    },
  ])
})

test("preserves zero prices and rejects batch-size-only metadata", () => {
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 0,
      default: {
        cache_price: 0,
        input_price: 0,
        output_price: 0,
      },
    }),
  ).toEqual([
    {
      key: "default",
      cache: 0,
      contextMax: undefined,
      input: 0,
      output: 0,
    },
  ])

  expect(hasAdminModelTokenPrices({ batch_size: 1_000_000 })).toBe(false)
  expect(
    hasAdminModelTokenPrices({
      batch_size: 0,
      default: { input_price: 0 },
    }),
  ).toBe(true)

  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 0,
      default: { input_price: 500 },
    }),
  ).toEqual([])
  expect(
    getModelAiCreditsPriceTiers({
      default: { input_price: 500 },
    }),
  ).toEqual([])
})

test("ignores malformed, non-finite, and overflowing displayed prices", () => {
  const malformed = {
    batch_size: 1_000_000,
    default: {
      cache_price: Number.NaN,
      input_price: Number.POSITIVE_INFINITY,
      output_price: "2500" as unknown as number,
    },
  }

  expect(hasAdminModelTokenPrices(malformed)).toBe(false)
  expect(getModelAiCreditsPriceTiers(malformed)).toEqual([])
  expect(
    getModelAiCreditsPriceTiers({
      batch_size: 1,
      default: { input_price: Number.MAX_VALUE },
    }),
  ).toEqual([])
})

test("detects cache-write-only token billing without inventing display prices", () => {
  const cacheWriteOnly = {
    batch_size: 1_000_000,
    default: { cache_write_price: 0 },
  }

  expect(hasAdminModelTokenPrices(cacheWriteOnly)).toBe(true)
  expect(getModelAiCreditsPriceTiers(cacheWriteOnly)).toEqual([])
})
