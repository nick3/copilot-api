import * as React from "react"

import { useMotionPreference } from "@/lib/motion-preference"
import { cn } from "@/lib/utils"

export type ProgressProps = React.ComponentProps<"div"> & {
  /**
   * Progress value in the range 0-100.
   */
  value?: number
  /**
   * Extra classes applied to the inner indicator.
   */
  indicatorClassName?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function Progress({
  value = 0,
  className,
  indicatorClassName,
  style,
  ...props
}: ProgressProps) {
  const { effective } = useMotionPreference()

  const safeValue = Number.isFinite(value) ? clamp(value, 0, 100) : 0

  const animated = effective !== "off"
  const shimmer = effective === "magic"
  const speed = effective === "subtle" ? "4s" : "2.2s"

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={Math.round(safeValue)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "bg-muted/60 relative h-2 w-full overflow-hidden rounded-sm ring-1 ring-border/70",
        className
      )}
      style={{
        ...style,
        "--speed": speed,
      } as React.CSSProperties}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "relative h-full rounded-sm",
          "[container-type:inline-size] overflow-hidden",
          "transition-[width] duration-700 ease-out",
          "bg-[linear-gradient(90deg,var(--accent),var(--primary))]",
          "after:absolute after:inset-0 after:bg-[linear-gradient(135deg,transparent_0%,transparent_45%,rgba(0,0,0,0.25)_45%,rgba(0,0,0,0.25)_55%,transparent_55%,transparent_100%)] after:bg-[length:14px_14px] after:opacity-40 after:content-['']",
          shimmer
            ? "before:absolute before:inset-y-0 before:left-0 before:w-3/5 before:rounded-full before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)] before:opacity-50 before:animate-shimmer-slide before:content-['']"
            : undefined,
          animated ? "shadow-[0_0_18px_rgba(0,0,0,0.2)]" : undefined,
          indicatorClassName
        )}
        style={{ width: `${safeValue}%` }}
      />
    </div>
  )
}

export { Progress }
