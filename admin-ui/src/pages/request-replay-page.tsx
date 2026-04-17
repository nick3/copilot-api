import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router-dom"

import {
  AdminApiError,
  type OutboundBlob,
  getDevMode,
  getRequestOutbound,
} from "@/lib/admin-api"
import { ReplayAccountSelect } from "@/components/replay/replay-account-select"
import {
  ReplayBodyEditor,
  validateReplayBody,
} from "@/components/replay/replay-body-editor"
import { ReplayContextCard } from "@/components/replay/replay-context-card"
import { ReplayHeadersEditor } from "@/components/replay/replay-headers-editor"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Skeleton } from "@/components/ui/skeleton"

type ReplayPhase = "loading-blob" | "no-blob" | "ready" | "error"

type ReplayForm = {
  accountId: string
  headers: Array<{ key: string; value: string; editable: boolean }>
  bodyText: string
  mode: "collect" | "live"
}

function buildReplayForm(blob: OutboundBlob): ReplayForm {
  return {
    accountId: blob.original?.account_id ?? "",
    headers: Object.entries(blob.request_headers).map(([key, value]) => ({
      key,
      value,
      editable: !blob.redacted_header_keys.includes(key),
    })),
    bodyText: blob.request_body ?? "",
    mode: "collect",
  }
}

export function RequestReplayPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { requestId = "" } = useParams()

  const [phase, setPhase] = useState<ReplayPhase>("loading-blob")
  const [blob, setBlob] = useState<OutboundBlob | null>(null)
  const [initialForm, setInitialForm] = useState<ReplayForm | null>(null)
  const [form, setForm] = useState<ReplayForm | null>(null)
  const [errorTitle, setErrorTitle] = useState<string | null>(null)
  const [errorDescription, setErrorDescription] = useState<string | null>(null)

  useEffect(() => {
    if (!requestId) return

    let cancelled = false

    async function run(): Promise<void> {
      setPhase("loading-blob")
      setBlob(null)
      setInitialForm(null)
      setForm(null)
      setErrorTitle(null)
      setErrorDescription(null)

      try {
        const [devMode, outboundBlob] = await Promise.all([
          getDevMode(),
          getRequestOutbound(requestId),
        ])

        if (cancelled) return

        if (!devMode.enabled) {
          setPhase("error")
          setErrorTitle(t("replayPage.devModeDisabled"))
          setErrorDescription(t("replayPage.devModeDisabledHint"))
          return
        }

        const nextForm = buildReplayForm(outboundBlob)
        setBlob(outboundBlob)
        setInitialForm(nextForm)
        setForm(nextForm)
        setPhase("ready")
      } catch (err) {
        if (cancelled) return

        if (err instanceof AdminApiError) {
          if (err.status === 404) {
            setPhase("no-blob")
            return
          }

          setPhase("error")
          setErrorTitle(t("replayPage.loadError"))
          setErrorDescription(err.message)
          return
        }

        setPhase("error")
        setErrorTitle(t("replayPage.loadError"))
        setErrorDescription(String(err))
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [requestId, t])

  const isDirty = useMemo(() => {
    if (!initialForm || !form) return false
    return JSON.stringify(initialForm) !== JSON.stringify(form)
  }, [form, initialForm])
  const bodyValidation = useMemo(
    () => validateReplayBody(form?.bodyText ?? "", blob?.request_body_kind ?? "text"),
    [blob?.request_body_kind, form?.bodyText],
  )

  function resetForm(): void {
    if (!initialForm) return
    setForm(initialForm)
  }

  if (!requestId) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("replayPage.title")}</CardTitle>
            <CardDescription>{t("replayPage.loadError")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InlineAlert
              variant="error"
              title={t("replayPage.loadError")}
              description="Missing requestId"
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (phase === "loading-blob") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("replayPage.title")}</CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-40" />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (phase === "no-blob") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/request/${encodeURIComponent(requestId)}`}>
              <ArrowLeftIcon className="size-4" />
              {t("replayPage.back")}
            </Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("replayPage.title")}</CardTitle>
            <CardDescription>{t("replayPage.noBlobHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InlineAlert
              variant="warning"
              title={t("replayPage.noBlob")}
              description={t("replayPage.noBlobHint")}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/request/${encodeURIComponent(requestId)}`}>
              <ArrowLeftIcon className="size-4" />
              {t("replayPage.back")}
            </Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("replayPage.title")}</CardTitle>
            <CardDescription>{errorDescription || t("replayPage.loadError")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InlineAlert
              variant="error"
              title={errorTitle || t("replayPage.loadError")}
              description={errorDescription || undefined}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!blob || !form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("replayPage.title")}</CardTitle>
          <CardDescription>{t("replayPage.loadError")}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/request/${encodeURIComponent(requestId)}`}>
            <ArrowLeftIcon className="size-4" />
            {t("replayPage.back")}
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={resetForm}
          disabled={!isDirty}
        >
          <RotateCcwIcon className="size-4" />
          {t("replayPage.reset")}
        </Button>
      </div>

      <ReplayContextCard blob={blob} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <ReplayAccountSelect
            value={form.accountId}
            originalAccountId={blob.original?.account_id ?? null}
            onChange={(accountId) => {
              setForm({ ...form, accountId })
            }}
          />
          <ReplayHeadersEditor
            headers={form.headers}
            onChange={(headers) => {
              setForm({ ...form, headers })
            }}
          />
          <ReplayBodyEditor
            value={form.bodyText}
            kind={blob.request_body_kind}
            originalValue={blob.request_body ?? ""}
            onChange={(bodyText) => {
              setForm({ ...form, bodyText })
            }}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("replayPage.placeholderResponse")}</CardTitle>
            <CardDescription>
              {bodyValidation.ok
                ? t("replayPage.placeholderResponse")
                : `${t("replayPage.body.invalid")}: ${bodyValidation.message}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {`mode: ${form.mode}\nresponseStatus: ${blob.response_status}\ncanSend: ${String(bodyValidation.ok)}`}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
