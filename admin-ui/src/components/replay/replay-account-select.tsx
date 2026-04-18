import { AlertCircleIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  getAdminAccounts,
  type AdminAccountItem,
} from "@/lib/admin-api"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const ACCOUNTS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

type ReplayAccountSelectProps = {
  value: string
  originalAccountId: string | null
  onChange: (accountId: string) => void
}

function sortAccounts(
  accounts: AdminAccountItem[],
  originalAccountId: string | null,
): AdminAccountItem[] {
  return [...accounts].sort((left, right) => {
    if (left.account_id === originalAccountId && right.account_id !== originalAccountId) {
      return -1
    }
    if (right.account_id === originalAccountId && left.account_id !== originalAccountId) {
      return 1
    }
    return left.account_id.localeCompare(right.account_id)
  })
}

export function ReplayAccountSelect({
  value,
  originalAccountId,
  onChange,
}: ReplayAccountSelectProps): React.JSX.Element {
  const { t } = useTranslation()
  const [accounts, setAccounts] = useState<AdminAccountItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function loadAccounts(): Promise<void> {
      setLoading(true)
      try {
        const response = await getAdminAccounts({
          sinceMs: Date.now() - ACCOUNTS_LOOKBACK_MS,
          includeStats: false,
        })

        if (cancelled) return

        const enabledAccounts = response.items.filter(
          (item) => item.runtime?.enabled !== false,
        )
        setAccounts(sortAccounts(enabledAccounts, originalAccountId))
      } catch (error) {
        console.error("Failed to load accounts", error)
        if (!cancelled) {
          setAccounts([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadAccounts()

    return () => {
      cancelled = true
    }
  }, [originalAccountId])

  const selectableAccounts = useMemo(
    () => accounts.filter((item) => item.runtime?.failed !== true),
    [accounts],
  )

  const failedAccounts = useMemo(
    () => accounts.filter((item) => item.runtime?.failed === true),
    [accounts],
  )

  const allOptions = useMemo(
    () => [...selectableAccounts, ...failedAccounts],
    [failedAccounts, selectableAccounts],
  )

  const hasOptions = allOptions.length > 0
  const placeholder = hasOptions
    ? t("replayPage.account.label")
    : t("replayPage.account.noAccounts")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("replayPage.account.label")}</CardTitle>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <Select value={value} onValueChange={onChange} disabled={loading || !hasOptions}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {selectableAccounts.map((account) => {
                const isOriginal = account.account_id === originalAccountId
                return (
                  <SelectItem key={account.account_id} value={account.account_id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs">{account.account_id}</span>
                      {isOriginal ? (
                        <Badge variant="secondary">{t("replayPage.account.original")}</Badge>
                      ) : null}
                    </span>
                  </SelectItem>
                )
              })}

              {failedAccounts.map((account) => {
                const isOriginal = account.account_id === originalAccountId
                const reason = account.runtime?.failureReason || t("common.failed")
                return (
                  <SelectItem key={account.account_id} value={account.account_id} disabled>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-xs">{account.account_id}</span>
                          {isOriginal ? (
                            <Badge variant="secondary">{t("replayPage.account.original")}</Badge>
                          ) : null}
                          <AlertCircleIcon className="text-destructive size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{reason}</TooltipContent>
                    </Tooltip>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </TooltipProvider>
      </CardContent>
    </Card>
  )
}
