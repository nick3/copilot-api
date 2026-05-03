import * as React from "react"

import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, EyeIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { copyText } from "@/lib/clipboard"
import { fmtLocalDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface JsonViewerProps {
  value: unknown
  search?: string
  defaultExpandedDepth?: number
  className?: string
}

const MAX_ITEMS_PER_NODE = 200
const LONG_STRING_THRESHOLD = 2000
const LONG_STRING_PREVIEW_LENGTH = 240

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function highlight(text: string, query: string | undefined): React.ReactNode {
  const q = query?.trim()
  if (!q) return text

  const lower = text.toLowerCase()
  const needle = q.toLowerCase()

  const parts: React.ReactNode[] = []
  let i = 0

  while (i < text.length) {
    const idx = lower.indexOf(needle, i)
    if (idx === -1) {
      parts.push(text.slice(i))
      break
    }

    if (idx > i) parts.push(text.slice(i, idx))

    parts.push(
      <mark
        key={`${idx}-${needle}`}
        className="bg-accent/50 text-foreground rounded px-0.5"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>
    )

    i = idx + needle.length
  }

  return <>{parts}</>
}

function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count)
}

function getLongStringPreview(value: string): string {
  if (value.length <= LONG_STRING_PREVIEW_LENGTH) return value
  return `${value.slice(0, LONG_STRING_PREVIEW_LENGTH - 1)}…`
}

function isLongString(value: unknown): value is string {
  return typeof value === "string" && value.length >= LONG_STRING_THRESHOLD
}

function formatPrimitive(
  value: unknown,
  search: string | undefined,
  name: string | undefined,
): React.ReactNode {
  if (value == null) return <span className="text-muted-foreground">null</span>

  if (typeof value === "string") {
    return isLongString(value) ?
        <LongStringValue value={value} search={search} />
      : <span className="text-foreground">
          &quot;{highlight(value, search)}&quot;
        </span>
  }

  if (typeof value === "number") {
    const raw = String(value)

    if (!name || !/_at_ms$/.test(name)) {
      return <span className="text-foreground">{raw}</span>
    }

    // Guard against misleading dates when the value isn't a real epoch-ms timestamp.
    // Keep this conservative: only show local-time hints for values in a reasonable range.
    const MIN_TIMESTAMP_MS = 946684800000 // 2000-01-01
    const MAX_TIMESTAMP_MS = 4102444800000 // 2100-01-01
    if (value < MIN_TIMESTAMP_MS || value > MAX_TIMESTAMP_MS) {
      return <span className="text-foreground">{raw}</span>
    }

    const local = fmtLocalDateTime(value)
    if (!local) return <span className="text-foreground">{raw}</span>

    return (
      <>
        <span className="text-foreground" title={local}>
          {raw}
        </span>
        <span className="text-muted-foreground ml-1">
          ({highlight(local, search)})
        </span>
      </>
    )
  }

  if (typeof value === "boolean") {
    return <span className="text-foreground">{value ? "true" : "false"}</span>
  }

  return <span className="text-foreground">{String(value)}</span>
}

function LongStringValue({
  value,
  search,
}: {
  value: string
  search: string | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const normalizedSearch = search?.trim().toLowerCase()
  const hasSearchMatch = normalizedSearch ? value.toLowerCase().includes(normalizedSearch) : false
  const preview = getLongStringPreview(value)

  async function handleCopy(): Promise<void> {
    try {
      await copyText(value)
      toast.success(t("common.copied"))
    } catch (error) {
      toast.error(t("common.copyFailed"), {
        description: String(error),
      })
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/15 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("jsonViewer.longStringLabel")}</span>
        <span>·</span>
        <span>
          {formatCount(value.length)} {t("jsonViewer.longStringChars")}
        </span>
      </div>

      <div className="font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
        &quot;{highlight(preview, search)}&quot;
      </div>

      {hasSearchMatch ? (
        <div className="text-[11px] text-muted-foreground">
          {t("jsonViewer.longStringSearchMatch")}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 font-sans">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setOpen(true)}
        >
          <EyeIcon className="size-3.5" />
          {t("jsonViewer.longStringViewFull")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => void handleCopy()}
        >
          <CopyIcon className="size-3.5" />
          {t("jsonViewer.longStringCopy")}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="border-b px-4 pt-4 pb-4 sm:px-6">
            <DialogTitle>{t("jsonViewer.longStringLabel")}</DialogTitle>
            <DialogDescription>
              {formatCount(value.length)} {t("jsonViewer.longStringChars")}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="rounded-md border bg-muted/10 p-3">
              <div className="font-mono text-xs leading-5 whitespace-pre-wrap break-all">
                {highlight(value, search)}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NodeRow({
  depth,
  name,
  valuePreview,
  expanded,
  toggle,
  t,
}: {
  depth: number
  name?: React.ReactNode
  valuePreview: React.ReactNode
  expanded: boolean
  toggle?: () => void
  t: TFunction
}): React.JSX.Element {
  return (
    <div
      className="flex items-start gap-2"
      style={{ paddingLeft: depth * 12 }}
    >
      {toggle ? (
        <button
          type="button"
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground mt-0.5"
          aria-label={expanded ? t("jsonViewer.collapse") : t("jsonViewer.expand")}
        >
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
        </button>
      ) : (
        <span className="size-4" />
      )}

      {name ? (
        <>
          <span className="text-muted-foreground">{name}</span>
          <span className="text-muted-foreground">:</span>
        </>
      ) : (
        <span className="text-muted-foreground">{t("jsonViewer.root")}</span>
      )}

      <div className="min-w-0 flex-1 break-words">{valuePreview}</div>
    </div>
  )
}

function JsonNode({
  value,
  name,
  path,
  depth,
  search,
  baseExpandDepth,
  expandedPaths,
  collapsedPaths,
  onToggle,
  t,
}: {
  value: unknown
  name?: string
  path: string
  depth: number
  search: string | undefined
  baseExpandDepth: number
  expandedPaths: Set<string>
  collapsedPaths: Set<string>
  onToggle: (path: string, nextExpanded: boolean) => void
  t: TFunction
}): React.JSX.Element {
  const isObj = isRecord(value)
  const isArr = Array.isArray(value)

  const isContainer = isObj || isArr

  const expanded =
    isContainer &&
    (collapsedPaths.has(path)
      ? false
      : expandedPaths.has(path)
        ? true
        : depth < baseExpandDepth)

  if (!isContainer) {
    return (
      <NodeRow
        depth={depth}
        name={name ? highlight(name, search) : undefined}
        valuePreview={formatPrimitive(value, search, name)}
        expanded={false}
        t={t}
      />
    )
  }

  const count = isArr ? value.length : Object.keys(value).length
  const label = isArr
    ? t("jsonViewer.arrayLabel", { count })
    : t("jsonViewer.objectLabel", { count })

  return (
    <div className="space-y-1">
      <NodeRow
        depth={depth}
        name={name ? highlight(name, search) : undefined}
        valuePreview={<span className="text-muted-foreground">{label}</span>}
        expanded={expanded}
        toggle={() => onToggle(path, !expanded)}
        t={t}
      />

      {expanded ? (
        <div className="space-y-1">
          {isArr
            ? value
                .slice(0, MAX_ITEMS_PER_NODE)
                .map((child, idx) => (
                  <JsonNode
                    key={`${path}[${idx}]`}
                    value={child}
                    name={`[${idx}]`}
                    path={`${path}[${idx}]`}
                    depth={depth + 1}
                    search={search}
                    baseExpandDepth={baseExpandDepth}
                    expandedPaths={expandedPaths}
                    collapsedPaths={collapsedPaths}
                    onToggle={onToggle}
                    t={t}
                  />
                ))
            : Object.entries(value)
                .slice(0, MAX_ITEMS_PER_NODE)
                .map(([k, child]) => (
                  <JsonNode
                    key={`${path}.${k}`}
                    value={child}
                    name={k}
                    path={`${path}.${k}`}
                    depth={depth + 1}
                    search={search}
                    baseExpandDepth={baseExpandDepth}
                    expandedPaths={expandedPaths}
                    collapsedPaths={collapsedPaths}
                    onToggle={onToggle}
                    t={t}
                  />
                ))}

          {count > MAX_ITEMS_PER_NODE ? (
            <NodeRow
              depth={depth + 1}
              valuePreview={
                <span className="text-muted-foreground">
                  {t("jsonViewer.more", { count: count - MAX_ITEMS_PER_NODE })}
                </span>
              }
              expanded={false}
              t={t}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function JsonViewer({
  value,
  search,
  defaultExpandedDepth = 2,
  className,
}: JsonViewerProps): React.JSX.Element {
  const [baseExpandDepth, setBaseExpandDepth] = React.useState(defaultExpandedDepth)
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set())
  const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(() => new Set())
  const { t } = useTranslation()

  function toggle(path: string, nextExpanded: boolean): void {
    if (nextExpanded) {
      setCollapsedPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
      return
    }

    setExpandedPaths((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    setCollapsedPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }

  function expandAll(): void {
    setBaseExpandDepth(99)
    setCollapsedPaths(new Set())
    setExpandedPaths(new Set())
  }

  function collapseAll(): void {
    setBaseExpandDepth(0)
    setExpandedPaths(new Set())
    setCollapsedPaths(new Set())
  }

  function getStatusText(): string {
    if (baseExpandDepth === 0) return t("jsonViewer.statusCollapsed")
    if (baseExpandDepth >= 99) return t("jsonViewer.statusExpanded")
    return t("jsonViewer.statusDepth", { depth: baseExpandDepth })
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={expandAll}>
          {t("jsonViewer.expandAll")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={collapseAll}>
          {t("jsonViewer.collapseAll")}
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">
          {getStatusText()}
        </span>
      </div>

      <div className="bg-muted/20 overflow-auto rounded-md border p-3 font-mono text-xs">
        <JsonNode
          value={value}
          path="$"
          depth={0}
          search={search}
          baseExpandDepth={baseExpandDepth}
          expandedPaths={expandedPaths}
          collapsedPaths={collapsedPaths}
          onToggle={toggle}
          t={t}
        />
      </div>
    </div>
  )
}
