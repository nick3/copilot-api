import React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const rainbowButtonVariants = cva(
  cn(
    "relative cursor-pointer group transition-colors",
    "inline-flex items-center justify-center gap-2 shrink-0",
    "rounded-sm border outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "font-display text-[0.75rem] font-semibold uppercase tracking-[0.2em] whitespace-nowrap",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0"
  ),
  {
    variants: {
      variant: {
        default: cn(
          "bg-accent text-accent-foreground border-accent/80 shadow-[0_18px_35px_-28px_rgba(0,0,0,0.7)]",
          "before:absolute before:inset-0 before:bg-[linear-gradient(135deg,transparent_0%,transparent_42%,rgba(0,0,0,0.22)_42%,rgba(0,0,0,0.22)_52%,transparent_52%,transparent_100%)] before:bg-[length:18px_18px] before:opacity-45 before:content-[''] before:pointer-events-none",
          "after:absolute after:inset-y-1 after:right-1 after:w-1 after:bg-foreground/20 after:content-[''] after:pointer-events-none",
          "dark:before:bg-[linear-gradient(135deg,transparent_0%,transparent_42%,rgba(255,255,255,0.16)_42%,rgba(255,255,255,0.16)_52%,transparent_52%,transparent_100%)]"
        ),
        outline: cn(
          "bg-transparent text-foreground border-border/70 shadow-[0_12px_24px_-20px_rgba(0,0,0,0.6)]",
          "before:absolute before:inset-0 before:bg-[linear-gradient(135deg,transparent_0%,transparent_42%,rgba(0,0,0,0.15)_42%,rgba(0,0,0,0.15)_52%,transparent_52%,transparent_100%)] before:bg-[length:18px_18px] before:opacity-35 before:content-[''] before:pointer-events-none",
          "after:absolute after:inset-y-1 after:right-1 after:w-1 after:bg-foreground/10 after:content-[''] after:pointer-events-none",
          "dark:before:bg-[linear-gradient(135deg,transparent_0%,transparent_42%,rgba(255,255,255,0.12)_42%,rgba(255,255,255,0.12)_52%,transparent_52%,transparent_100%)]"
        ),
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 gap-1.5 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

interface RainbowButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof rainbowButtonVariants> {
  asChild?: boolean
}

const RainbowButton = React.forwardRef<HTMLButtonElement, RainbowButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        data-slot="button"
        className={cn(rainbowButtonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)

RainbowButton.displayName = "RainbowButton"

export { RainbowButton, rainbowButtonVariants, type RainbowButtonProps }
