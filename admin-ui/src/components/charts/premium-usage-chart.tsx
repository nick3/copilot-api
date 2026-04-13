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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

function formatXLabel(dateStr: string, isHourly: boolean): string {
  if (isHourly) {
    // dateStr is like "2026-04-13T14:00:00" or similar -- extract HH:00
    const match = /T(\d{2})/.exec(dateStr)
    return match ? `${match[1]}:00` : dateStr
  }
  // dateStr is like "2026-04-13" -- extract MM-DD
  const match = /(\d{2})-(\d{2})$/.exec(dateStr)
  return match ? `${match[1]}-${match[2]}` : dateStr
}

function CustomTooltipContent({
  active,
  payload,
  label,
  t,
}: {
  active: boolean
  payload: ReadonlyArray<{ payload?: unknown }>
  label?: string | number
  t: (key: string) => string
}): React.JSX.Element | null {
  if (!active || payload.length === 0) return null

  const item = payload[0]?.payload as DailyStatsItem | undefined
  if (!item) return null

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{String(label ?? "")}</div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("statistics.costUnits")}</span>
          <span className="tabular-nums font-medium">{item.cost_units_sum}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("statistics.requestCount")}</span>
          <span className="tabular-nums font-medium">{item.request_count}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("statistics.tokensTotal")}</span>
          <span className="tabular-nums font-medium">{item.tokens_total}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{t("statistics.errorCount")}</span>
          <span className="tabular-nums font-medium">{item.error_count}</span>
        </div>
      </div>
    </div>
  )
}

export function PremiumUsageChart({
  data,
  isHourly = false,
}: {
  data: DailyStatsItem[]
  isHourly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        label: formatXLabel(d.date, isHourly),
      })),
    [data, isHourly],
  )

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
                content={({ active, payload, label }) => (
                  <CustomTooltipContent
                    active={active}
                    payload={payload}
                    label={label}
                    t={t}
                  />
                )}
              />
              <Area
                yAxisId="cost"
                type="monotone"
                dataKey="cost_units_sum"
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
