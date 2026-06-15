import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { DailyStatsItem } from "@/lib/admin-api"
import {
  formatDailyLabel,
  formatHourlyLabel,
  formatHourlyTooltip,
  hourlyDataCrossesDays,
} from "@/lib/chart-format"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type ChartItem = DailyStatsItem & { label: string; tooltipDate?: string }

function renderTooltip(
  t: (key: string) => string,
  // Recharts v3 Tooltip content props are loosely typed
  props: Record<string, unknown>,
): React.JSX.Element | null {
  const active = props.active as boolean | undefined
  const payload = props.payload as
    | ReadonlyArray<{ payload?: ChartItem }>
    | undefined

  if (!active || !payload?.length) return null
  const item = payload[0]?.payload
  if (!item) return null

  const header = item.tooltipDate ?? String(item.label ?? "")

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{header}</div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("statistics.costUnits")}
          </span>
          <span className="tabular-nums font-medium">
            {item.credits_consumed}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("statistics.requestCount")}
          </span>
          <span className="tabular-nums font-medium">
            {item.request_count}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("statistics.tokensTotal")}
          </span>
          <span className="tabular-nums font-medium">
            {item.tokens_total}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("statistics.errorCount")}
          </span>
          <span className="tabular-nums font-medium">
            {item.error_count}
          </span>
        </div>
      </div>
    </div>
  )
}

export function PremiumUsageChart({
  data,
  isHourly = false,
}: {
  data: Array<DailyStatsItem>
  isHourly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()

  const chartData = useMemo(() => {
    if (!isHourly) {
      return data.map((d) => ({
        ...d,
        label: formatDailyLabel(d.date),
      }))
    }

    const crossesDays = hourlyDataCrossesDays(data.map((d) => d.date))
    const baseLabels = data.map((d) => formatHourlyLabel(d.date, crossesDays))
    const duplicateLabels = new Set(
      baseLabels.filter((label, index) => baseLabels.indexOf(label) !== index),
    )

    return data.map((d, index) => {
      const baseLabel = baseLabels[index]
      const includeOffset = duplicateLabels.has(baseLabel)
      return {
        ...d,
        label: formatHourlyLabel(d.date, crossesDays, { includeOffset }),
        tooltipDate: formatHourlyTooltip(d.date, { includeOffset: true }),
      }
    })
  }, [data, isHourly])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("statistics.premiumUsage")}</CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
            {t("statistics.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="cost"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <YAxis
                yAxisId="count"
                orientation="right"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <Tooltip
                content={(props: Record<string, unknown>) =>
                  renderTooltip(t, props)
                }
              />
              <Area
                yAxisId="cost"
                type="monotone"
                dataKey="credits_consumed"
                name={t("statistics.costUnits")}
                fill="var(--color-chart-1)"
                fillOpacity={0.2}
                stroke="var(--color-chart-1)"
                strokeWidth={2}
              />
              <Line
                yAxisId="count"
                type="monotone"
                dataKey="request_count"
                name={t("statistics.requestCount")}
                stroke="var(--color-chart-2)"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
