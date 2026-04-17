import { PlusIcon, TrashIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export type HeaderEntry = {
  key: string
  value: string
  editable: boolean
}

type ReplayHeadersEditorProps = {
  headers: Array<HeaderEntry>
  onChange: (headers: Array<HeaderEntry>) => void
}

const HEADER_KEY_PATTERN = /^[A-Za-z0-9-]+$/
const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^x-github-token$/i,
  /-token$/i,
  /-secret$/i,
  /^cookie$/i,
  /^x-api-key$/i,
]

function isSensitiveHeaderKey(value: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

function isValidHeaderKey(value: string): boolean {
  return value.length > 0 && HEADER_KEY_PATTERN.test(value)
}

export function ReplayHeadersEditor({
  headers,
  onChange,
}: ReplayHeadersEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  const lockedHeaders = useMemo(
    () => headers.filter((header) => !header.editable),
    [headers],
  )
  const editableHeaders = useMemo(
    () => headers.filter((header) => header.editable),
    [headers],
  )

  function updateEditableHeader(
    index: number,
    field: "key" | "value",
    nextValue: string,
  ): void {
    const nextHeaders = editableHeaders.map((header, headerIndex) => {
      if (headerIndex !== index) return header

      if (field === "key" && isSensitiveHeaderKey(nextValue)) {
        toast.error(t("replayPage.headers.sensitiveKey"))
        return header
      }

      return {
        ...header,
        [field]: nextValue,
      }
    })

    onChange([...lockedHeaders, ...nextHeaders])
  }

  function deleteEditableHeader(index: number): void {
    onChange([
      ...lockedHeaders,
      ...editableHeaders.filter((_, headerIndex) => headerIndex !== index),
    ])
  }

  function addHeader(): void {
    onChange([
      ...lockedHeaders,
      ...editableHeaders,
      { key: "", value: "", editable: true },
    ])
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("replayPage.headers.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {lockedHeaders.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              {t("replayPage.headers.authTitle")}
            </p>
            <div className="space-y-2">
              {lockedHeaders.map((header, index) => (
                <div key={`${header.key}-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <Input value={header.key} disabled readOnly />
                  <Input value="***" disabled readOnly />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          {editableHeaders.map((header, index) => {
            const showInvalidState = header.key.length > 0 && !isValidHeaderKey(header.key)
            return (
              <div
                key={`${header.key}-${index}`}
                className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <Input
                  value={header.key}
                  onChange={(event) => updateEditableHeader(index, "key", event.target.value)}
                  placeholder={t("replayPage.headers.keyPlaceholder")}
                  aria-invalid={showInvalidState}
                />
                <Input
                  value={header.value}
                  onChange={(event) => updateEditableHeader(index, "value", event.target.value)}
                  placeholder={t("replayPage.headers.valuePlaceholder")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 self-start text-muted-foreground"
                  onClick={() => deleteEditableHeader(index)}
                  aria-label={t("settingsPage.common.remove")}
                >
                  <TrashIcon className="size-4" />
                </Button>
                {showInvalidState ? (
                  <p className="text-destructive md:col-span-3 text-xs" role="alert">
                    {t("replayPage.headers.invalidKey")}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>

        <Button type="button" variant="outline" onClick={addHeader}>
          <PlusIcon className="size-4" />
          {t("replayPage.headers.addHeader")}
        </Button>
      </CardContent>
    </Card>
  )
}
