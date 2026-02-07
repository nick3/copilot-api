import * as React from "react"

import { cn } from "@/lib/utils"

export type SwitchProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function SwitchComponent(
  {
    className,
    checked,
    defaultChecked,
    onCheckedChange,
    disabled,
    onClick,
    type = "button",
    ...props
  }: SwitchProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
): React.JSX.Element {
  const isControlled = checked !== undefined
  const [internalChecked, setInternalChecked] = React.useState<boolean>(
    defaultChecked ?? false,
  )
  const isChecked = isControlled ? checked : internalChecked

  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    onClick?.(event)
    if (event.defaultPrevented || disabled) return
    const next = !isChecked
    if (!isControlled) setInternalChecked(next)
    onCheckedChange?.(next)
  }

  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={Boolean(isChecked)}
      data-state={isChecked ? "checked" : "unchecked"}
      data-disabled={disabled ? "true" : "false"}
      className={cn(
        "inline-flex h-6 w-12 shrink-0 items-center rounded-sm border border-input bg-input/35 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-[color,box-shadow,border-color] outline-none",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        isChecked ? "bg-accent border-accent" : "bg-input/40",
        className,
      )}
      onClick={handleClick}
      disabled={disabled}
      {...props}
    >
      <span
        data-state={isChecked ? "checked" : "unchecked"}
        className={cn(
          "pointer-events-none inline-block size-4 rounded-sm bg-background shadow-[0_4px_10px_-6px_rgba(0,0,0,0.45)] transition-transform",
          isChecked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  )
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(SwitchComponent)
Switch.displayName = "Switch"

export { Switch }
