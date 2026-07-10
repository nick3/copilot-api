import type {
  AdminModelDetailsItem,
  AdminModelTokenPriceTier,
  AdminModelTokenPrices,
} from "@/lib/admin-api"

const AI_CREDITS_PER_MILLION_TOKENS = 1_000_000
const NANO_AI_CREDITS_SCALE = 1_000_000_000

export type ModelAiCreditsPriceTier = {
  key: "default" | "long_context"
  cache?: number
  contextMax?: number
  input?: number
  output?: number
}

function hasTierPrices(
  tier: AdminModelTokenPriceTier | null | undefined,
): boolean {
  return (
    tier != null
    && [
      tier.cache_price,
      tier.cache_write_price,
      tier.input_price,
      tier.output_price,
    ].some((price) => typeof price === "number" && Number.isFinite(price))
  )
}

export function hasAdminModelTokenPrices(
  tokenPrices: AdminModelTokenPrices | null | undefined,
): boolean {
  return (
    tokenPrices != null
    && [tokenPrices, tokenPrices.default, tokenPrices.long_context].some(
      hasTierPrices,
    )
  )
}

function toAiCreditsPerMillion(
  price: number | undefined,
  batchSize: number | undefined,
  legacyNanoPrices: boolean,
): number | undefined {
  if (price == null || !Number.isFinite(price)) return undefined

  const creditsPerBatch =
    legacyNanoPrices ? price / NANO_AI_CREDITS_SCALE : price
  if (creditsPerBatch === 0) return 0

  if (batchSize == null) {
    return legacyNanoPrices ? creditsPerBatch : undefined
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) return undefined

  const normalized =
    creditsPerBatch * AI_CREDITS_PER_MILLION_TOKENS / batchSize

  return Number.isFinite(normalized) ? normalized : undefined
}

function normalizeTier(
  key: ModelAiCreditsPriceTier["key"],
  tier: AdminModelTokenPriceTier | null | undefined,
  batchSize: number | undefined,
  legacyNanoPrices: boolean,
): ModelAiCreditsPriceTier | undefined {
  if (!hasTierPrices(tier)) return undefined

  const normalized: ModelAiCreditsPriceTier = {
    key,
    cache: toAiCreditsPerMillion(
      tier?.cache_price,
      batchSize,
      legacyNanoPrices,
    ),
    contextMax:
      typeof tier?.context_max === "number" && Number.isFinite(tier.context_max) ?
        tier.context_max
      : undefined,
    input: toAiCreditsPerMillion(
      tier?.input_price,
      batchSize,
      legacyNanoPrices,
    ),
    output: toAiCreditsPerMillion(
      tier?.output_price,
      batchSize,
      legacyNanoPrices,
    ),
  }

  return [normalized.cache, normalized.input, normalized.output].some(
    (price) => price !== undefined,
  ) ? normalized : undefined
}

function hasSameDisplayedPrices(
  a: ModelAiCreditsPriceTier,
  b: ModelAiCreditsPriceTier,
): boolean {
  return a.cache === b.cache && a.input === b.input && a.output === b.output
}

export function getModelAiCreditsPriceTiers(
  tokenPrices: AdminModelTokenPrices | null | undefined,
): Array<ModelAiCreditsPriceTier> {
  if (!tokenPrices) return []

  const tieredDefault = normalizeTier(
    "default",
    tokenPrices.default,
    tokenPrices.batch_size,
    false,
  )
  const legacyDefault = normalizeTier(
    "default",
    {
      ...tokenPrices,
      context_max:
        tokenPrices.default?.context_max ?? tokenPrices.context_max,
    },
    tokenPrices.batch_size,
    true,
  )
  const defaultTier = tieredDefault ?? legacyDefault
  const longContextTier = normalizeTier(
    "long_context",
    tokenPrices.long_context,
    tokenPrices.batch_size,
    false,
  )

  if (
    defaultTier
    && longContextTier
    && hasSameDisplayedPrices(defaultTier, longContextTier)
  ) {
    return [defaultTier]
  }

  return [defaultTier, longContextTier].filter(
    (tier): tier is ModelAiCreditsPriceTier => tier !== undefined,
  )
}

export function isBillableModel(
  model: Pick<AdminModelDetailsItem, "billing">,
): boolean {
  return (
    model.billing?.tokenBasedBilling === true
    || model.billing?.is_premium === true
    || hasAdminModelTokenPrices(model.billing?.token_prices)
  )
}
