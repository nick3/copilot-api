import {
  ArrowLeftIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type OutboundBlob,
  type ReplayCollectResult,
  getDevMode,
  getRequestOutbound,
  replayCollect,
  replayLive,
} from "@/lib/admin-api"
import type { SSEEvent } from "@/lib/sse"
import { ReplayAccountSelect } from "@/components/replay/replay-account-select"
import {
  ReplayBodyEditor,
  validateReplayBody,
} from "@/components/replay/replay-body-editor"
import { ReplayContextCard } from "@/components/replay/replay-context-card"
import { ReplayHeadersEditor } from "@/components/replay/replay-headers-editor"
import { ReplayResponsePanel } from "@/components/replay/replay-response-panel"
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
        const devMode = await getDevMode()
        if (cancelled) return

        if (!devMode.enabled) {
          setPhase("error")
          setErrorTitle(t("replayPage.devModeDisabled"))
          setErrorDescription(t("replayPage.devModeDisabledHint"))
          return
        }

        const outboundBlob = await getRequestOutbound(requestId)
        if (cancelled) return

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

  /* ---- Send / streaming state ---- */
  const [sending, setSending] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [collectResult, setCollectResult] = useState<ReplayCollectResult | null>(null)
  const [liveEvents, setLiveEvents] = useState<Array<SSEEvent> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const canSend = bodyValidation.ok && !sending && !streaming && Boolean(form?.accountId)

  function buildOverrides(): { body?: string; headers?: Record<string, string> } {
    if (!form) return {}
    return {
      body: form.bodyText,
      headers: Object.fromEntries(
        form.headers.filter((h) => h.editable).map((h) => [h.key, h.value]),
      ),
    }
  }

  async function handleSend(): Promise<void> {
    if (!form || !requestId) return

    const overrides = buildOverrides()

    if (form.mode === "collect") {
      setSending(true)
      setCollectResult(null)
      setLiveEvents(null)
      try {
        const res = await replayCollect(requestId, { accountId: form.accountId, overrides })
        setCollectResult(res)
      } catch (err) {
        toast.error(err instanceof AdminApiError ? err.message : String(err))
      } finally {
        setSending(false)
      }
    } else {
      setStreaming(true)
      setCollectResult(null)
      setLiveEvents([])
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await replayLive(
          requestId,
          { accountId: form.accountId, overrides },
          (event) => setLiveEvents((prev) => [...(prev ?? []), event]),
          controller.signal,
        )
      } catch (err) {
        if (!controller.signal.aborted) {
          toast.error(err instanceof AdminApiError ? err.message : String(err))
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    }
  }

  function handleCancel(): void {
    abortRef.current?.abort()
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

        <div className="space-y-3">
          {/* Mode toggle + Send/Cancel toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border text-sm">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-l-md transition-colors ${form.mode === "collect" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                onClick={() => setForm({ ...form, mode: "collect" })}
                disabled={sending || streaming}
              >
                {t("replayPage.send.modeCollect")}
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 rounded-r-md transition-colors ${form.mode === "live" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                onClick={() => setForm({ ...form, mode: "live" })}
                disabled={sending || streaming}
              >
                {t("replayPage.send.modeLive")}
              </button>
            </div>

            {streaming ? (
              <Button variant="destructive" size="sm" onClick={handleCancel}>
                <SquareIcon className="size-4" />
                {t("replayPage.send.cancel")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canSend}
                onClick={() => void handleSend()}
              >
                {sending ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <SendIcon className="size-4" />
                )}
                {sending
                  ? t("replayPage.send.sending")
                  : streaming
                    ? t("replayPage.send.streaming")
                    : t("replayPage.send.button")}
              </Button>
            )}

            <span className="text-xs text-muted-foreground hidden sm:inline">
              {t("replayPage.send.modeHint")}
            </span>
          </div>

          <InlineAlert
            variant="warning"
            title={t("replayPage.send.quotaWarning")}
          />

          <ReplayResponsePanel
            result={collectResult}
            liveEvents={liveEvents}
            loading={sending}
            originalPath={blob.original?.path ?? null}
          />
        </div>
      </div>
    </div>
  )
}
