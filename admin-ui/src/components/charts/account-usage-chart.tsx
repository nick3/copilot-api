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

// Resolved hex values for tooltip color dots (CSS variables don't work in inline styles)
const TOOLTIP_DOT_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#8b5cf6", "#0891b2"]

function renderTooltip(
  accountIds: Array<string>,
  props: Record<string, unknown>,
): React.JSX.Element | null {
  const active = props.active as boolean | undefined
  const payload = props.payload as
    | ReadonlyArray<{ payload?: Record<string, number | string> }>
    | undefined
  const label = props.label as string | number | undefined

  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{String(label ?? "")}</div>
      <div className="space-y-0.5">
        {accountIds.map((id, idx) => (
          <div key={id} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: TOOLTIP_DOT_COLORS[idx % TOOLTIP_DOT_COLORS.length] }}
              />
              <span className="text-muted-foreground">{id}</span>
            </span>
            <span className="tabular-nums font-medium">{row[id] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatXLabel(dateStr: string, isHourly: boolean): string {
  if (isHourly) {
    const match = /(\d{2}):00/.exec(dateStr) ?? /T(\d{2})/.exec(dateStr)
    return match ? `${match[1]}:00` : dateStr
  }
  const match = /(\d{2})-(\d{2})$/.exec(dateStr)
  return match ? `${match[1]}-${match[2]}` : dateStr
}

export function AccountUsageChart({
  data,
  isHourly = false,
}: {
  data: Array<DailyAccountStatsItem>
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

    // Zero-fill: ensure every date row has a value for every account
    const rows = [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, values]) => {
        const row: Record<string, number | string> = {
          label: formatXLabel(date, isHourly),
        }
        for (const id of ids) {
          row[id] = values[id] ?? 0
        }
        return row
      })

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
                content={(props: Record<string, unknown>) =>
                  renderTooltip(accountIds, props)
                }
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
