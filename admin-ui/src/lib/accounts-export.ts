import type { AdminAccountItem } from "@/lib/admin-api"
import { fmtDurationSeconds, fmtLocalDateTime } from "@/lib/format"

function escapeCsvCell(value: string): string {
  const neutralized = /^[=+\-@]/u.test(value) ? `'${value}` : value
  return `"${neutralized.replaceAll('"', '""')}"`
}

export function getAccountsCsvFilename(now: Date = new Date()): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  const dd = String(now.getDate()).padStart(2, "0")
  return `accounts-${yyyy}-${mm}-${dd}.csv`
}

export function buildAccountsCsv(accounts: readonly AdminAccountItem[]): string {
  const headers = [
    "account_id",
    "status",
    "account_type",
    "requests",
    "errors",
    "tokens",
    "avg_duration_s",
    "last_request",
  ]

  const rows = accounts.map((account) => [
    account.account_id,
    account.runtime?.failed ? "failed" : "ok",
    account.account_type ?? "free",
    String(account.stats?.request_count ?? 0),
    String(account.stats?.error_count ?? 0),
    String(account.stats?.tokens_total ?? 0),
    fmtDurationSeconds(account.stats?.avg_duration_ms),
    fmtLocalDateTime(account.stats?.last_request_at_ms),
  ])

  return [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")),
  ].join("\n")
}
