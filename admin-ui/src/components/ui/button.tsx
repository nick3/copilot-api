import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "font-display inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border text-[0.72rem] font-semibold uppercase tracking-[0.18em] transition-[color,background-color,border-color,box-shadow,transform] duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:ring-destructive/30 aria-invalid:border-destructive active:translate-y-[1px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border-primary/80 shadow-[0_12px_26px_-18px_rgba(0,0,0,0.6)] hover:bg-primary/90 hover:shadow-[0_16px_30px_-20px_rgba(0,0,0,0.65)]",
        destructive:
          "bg-destructive text-white border-destructive/80 hover:bg-destructive/90 focus-visible:ring-destructive/40",
        outline:
          "border-border/70 bg-transparent text-foreground hover:bg-accent/10 hover:border-accent/70",
        secondary:
          "bg-secondary text-secondary-foreground border-border/60 hover:bg-secondary/85",
        ghost:
          "border-transparent text-foreground hover:bg-accent/10",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
