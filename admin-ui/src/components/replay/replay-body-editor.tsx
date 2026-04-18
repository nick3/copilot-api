import { CircleCheckIcon, OctagonXIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type ReplayBodyKind = "json" | "text" | "binary"

export type ReplayBodyEditorProps = {
  value: string
  kind: ReplayBodyKind
  originalValue: string
  onChange: (value: string) => void
}

export function validateReplayBody(
  bodyText: string,
  kind: ReplayBodyKind,
): { ok: true } | { ok: false; message: string } {
  if (kind !== "json") return { ok: true }
  if (!bodyText.trim()) return { ok: true }
  try {
    JSON.parse(bodyText)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export function ReplayBodyEditor({
  value,
  kind,
  originalValue,
  onChange,
}: ReplayBodyEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const validation = useMemo(() => validateReplayBody(value, kind), [kind, value])
  const binaryPreview = value.length > 600 ? `${value.slice(0, 600)}…` : value

  function reset(): void {
    onChange(originalValue)
  }

  function formatJson(): void {
    try {
      const formatted = JSON.stringify(JSON.parse(value), null, 2)
      onChange(formatted)
    } catch {
      toast.error(t("replayPage.body.formatError"))
    }
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{t("replayPage.body.title")}</CardTitle>
          <div className="flex items-center gap-2">
            {kind === "json" ? (
              <Button type="button" variant="outline" size="sm" onClick={formatJson}>
                {t("replayPage.body.format")}
              </Button>
            ) : null}
            {kind !== "binary" ? (
              <Button type="button" variant="outline" size="sm" onClick={reset}>
                {t("replayPage.body.reset")}
              </Button>
            ) : null}
          </div>
        </div>

        {kind === "json" ? (
          <div
            className={cn(
              "flex items-start gap-2 text-sm",
              validation.ok ? "text-green-600 dark:text-green-400" : "text-destructive",
            )}
            role="status"
            aria-live="polite"
          >
            {validation.ok ? (
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
            ) : (
              <OctagonXIcon className="mt-0.5 size-4 shrink-0" />
            )}
            <span>
              {validation.ok
                ? t("replayPage.body.valid")
                : `${t("replayPage.body.invalid")}: ${validation.message}`}
            </span>
          </div>
        ) : null}
      </CardHeader>

      <CardContent>
        {kind === "binary" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("replayPage.body.binaryReadOnly")}</p>
            <div className="max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
              {binaryPreview || "—"}
            </div>
          </div>
        ) : (
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-[300px] resize-y font-mono text-sm"
            aria-invalid={kind === "json" && !validation.ok}
            spellCheck={false}
          />
        )}
      </CardContent>
    </Card>
  )
}
