import type { CSSProperties, ReactNode } from "react"
import { forwardRef } from "react"

import { cn } from "@/lib/utils"

export type SettingsSectionCardProps = {
  id: string
  isActive: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Settings section wrapper with a signal bar on active state.
 */
export const SettingsSectionCard = forwardRef<HTMLDivElement, SettingsSectionCardProps>(
  ({ id, isActive, children, className, style }, ref) => {
    return (
      <div
        ref={ref}
        id={id}
        data-section-id={id}
        style={style}
        className={cn(
          "relative scroll-mt-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4",
          className
        )}
      >
        <div
          className={cn(
            "relative",
            isActive
              ? "before:absolute before:inset-y-3 before:-left-4 before:w-1 before:bg-accent before:shadow-[0_0_18px_var(--accent)] before:content-[''] after:absolute after:-left-4 after:top-3 after:h-6 after:w-2 after:border after:border-accent/60 after:content-['']"
              : undefined,
          )}
        >
          {children}
        </div>
      </div>
    )
  }
)

SettingsSectionCard.displayName = "SettingsSectionCard"
