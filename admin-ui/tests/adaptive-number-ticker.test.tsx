import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AdaptiveNumberPair } from "../src/components/ui/adaptive-number-ticker"

test("AdaptiveNumberPair does not forward internal measurement props to the DOM", () => {
  const html = renderToStaticMarkup(
    <AdaptiveNumberPair
      primaryValue={1001802257}
      secondaryValue={1001802257}
      secondaryDecimalPlaces={2}
      data-testid="adaptive-pair"
    />
  )

  expect(html).toContain("data-testid=\"adaptive-pair\"")
  expect(html).not.toContain("secondaryValue")
  expect(html).not.toContain("secondaryDecimalPlaces")
})
