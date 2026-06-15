import type { Model } from "~/services/copilot/get-models"

type ModelTokenPrices = NonNullable<Model["billing"]>["token_prices"]

export function hasTokenPrices(
  tokenPrices: ModelTokenPrices | null | undefined,
): boolean {
  return (
    tokenPrices != null
    && [
      tokenPrices.cache_price,
      tokenPrices.input_price,
      tokenPrices.output_price,
    ].some((price) => typeof price === "number" && Number.isFinite(price))
  )
}

export function hasEmptyTokenPrices(
  tokenPrices: ModelTokenPrices | null | undefined,
): boolean {
  return tokenPrices != null && !hasTokenPrices(tokenPrices)
}
