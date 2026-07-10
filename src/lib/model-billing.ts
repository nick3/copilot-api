import type {
  ModelTokenPriceTier,
  ModelTokenPrices,
} from "~/services/copilot/get-models"

function hasTierPrices(tier: ModelTokenPriceTier | null | undefined): boolean {
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

export function hasTokenPrices(
  tokenPrices: ModelTokenPrices | null | undefined,
): boolean {
  return (
    tokenPrices != null
    && [tokenPrices, tokenPrices.default, tokenPrices.long_context].some(
      hasTierPrices,
    )
  )
}

export function hasEmptyTokenPrices(
  tokenPrices: ModelTokenPrices | null | undefined,
): boolean {
  return tokenPrices != null && !hasTokenPrices(tokenPrices)
}
