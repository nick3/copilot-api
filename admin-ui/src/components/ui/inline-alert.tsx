import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type InlineAlertVariant = "info" | "success" | "warning" | "error"

export interface InlineAlertProps {
  variant?: InlineAlertVariant
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  className?: string
}

function iconForVariant(variant: InlineAlertVariant): React.JSX.Element {
  if (variant === "success") return <CircleCheckIcon className="size-4" />
  if (variant === "warning") return <TriangleAlertIcon className="size-4" />
  if (variant === "error") return <OctagonXIcon className="size-4" />
  return <InfoIcon className="size-4" />
}

function classNameForVariant(variant: InlineAlertVariant): string {
  switch (variant) {
    case "success":
      return "border-l-emerald-500/80 bg-emerald-500/8"
    case "warning":
      return "border-l-amber-500/80 bg-amber-500/8"
    case "error":
      return "border-l-destructive/80 bg-destructive/10"
    default:
      return "border-l-accent/80 bg-muted/25"
  }
}

export function InlineAlert({
  variant = "info",
  title,
  description,
  actionLabel,
  onAction,
  className,
}: InlineAlertProps): React.JSX.Element {
  const icon = iconForVariant(variant)

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-sm border border-border/70 border-l-[4px] p-3 shadow-[0_14px_28px_-22px_rgba(0,0,0,0.5)]",
        classNameForVariant(variant),
        className
      )}
    >
      <div className="mt-0.5 shrink-0 text-foreground">{icon}</div>

      <div className="min-w-0 flex-1">
        <div className="font-display text-[0.75rem] leading-5">{title}</div>
        {description ? (
          <div className="text-muted-foreground mt-1 text-sm leading-5">
            {description}
          </div>
        ) : null}
      </div>

      {actionLabel && onAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAction}
          className="shrink-0"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
