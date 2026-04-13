import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  Area,
  AreaChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { DailyAccountStatsItem } from "@/lib/admin-api"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
]

function formatXLabel(dateStr: string, isHourly: boolean): string {
  if (isHourly) {
    const match = /T(\d{2})/.exec(dateStr)
    return match ? `${match[1]}:00` : dateStr
  }
  const match = /(\d{2})-(\d{2})$/.exec(dateStr)
  return match ? `${match[1]}-${match[2]}` : dateStr
}

export function AccountUsageChart({
  data,
  isHourly = false,
}: {
  data: DailyAccountStatsItem[]
  isHourly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()

  const { pivoted, accountIds } = useMemo(() => {
    const dateMap = new Map<string, Record<string, number>>()
    const accountSet = new Set<string>()

    for (const item of data) {
      accountSet.add(item.account_id)

      let row = dateMap.get(item.date)
      if (!row) {
        row = {}
        dateMap.set(item.date, row)
      }
      row[item.account_id] = item.cost_units_sum
    }

    const ids = [...accountSet]

    const rows = [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, values]) => ({
        label: formatXLabel(date, isHourly),
        ...values,
      }))

    return { pivoted: rows, accountIds: ids }
  }, [data, isHourly])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("statistics.accountUsage")}</CardTitle>
      </CardHeader>
      <CardContent>
        {pivoted.length === 0 ? (
          <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
            {t("statistics.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={pivoted} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: "0.375rem",
                  fontSize: "0.75rem",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
              {accountIds.map((id, idx) => (
                <Area
                  key={id}
                  type="monotone"
                  dataKey={id}
                  name={id}
                  stackId="1"
                  fill={CHART_COLORS[idx % CHART_COLORS.length]}
                  fillOpacity={0.3}
                  stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                  strokeWidth={1.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
