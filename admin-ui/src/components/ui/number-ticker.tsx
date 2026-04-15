import { useEffect, useMemo, useRef } from "react"
import type { ComponentPropsWithoutRef } from "react"
import { useInView, useMotionValue, useSpring } from "motion/react"

import { cn } from "@/lib/utils"

export const numberTickerTextClassName =
  "inline-block tracking-wider text-black tabular-nums dark:text-white"

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  direction?: "up" | "down"
  delay?: number
  decimalPlaces?: number
  formatOptions?: Intl.NumberFormatOptions
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  formatOptions,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const formatter = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
        ...formatOptions,
      }),
    [decimalPlaces, formatOptions]
  )
  const shouldAnimate = formatOptions?.notation !== "compact"
  const motionValue = useMotionValue(shouldAnimate ? direction === "down" ? value : startValue : value)
  const springValue = useSpring(motionValue, {
    damping: 60,
    stiffness: 100,
  })
  const isInView = useInView(ref, { once: true, margin: "0px" })
  const hasAnimated = useRef(false)

  // Initial animation on first view
  useEffect(() => {
    if (!isInView || hasAnimated.current) {
      return
    }

    hasAnimated.current = true
    if (!shouldAnimate) {
      motionValue.set(value)
      return
    }

    const timer = setTimeout(() => {
      motionValue.set(direction === "down" ? startValue : value)
    }, delay * 1000)
    return () => clearTimeout(timer)
  }, [motionValue, isInView, delay, value, direction, startValue, shouldAnimate])

  // Subsequent value changes: spring smoothly to new value (auto-refresh)
  useEffect(() => {
    if (hasAnimated.current && shouldAnimate) {
      motionValue.set(direction === "down" ? startValue : value)
    }
  }, [motionValue, value, direction, startValue, shouldAnimate])

  useEffect(() => {
    const updateText = (latest: number) => {
      if (!ref.current) {
        return
      }

      ref.current.textContent = formatter.format(Number(latest.toFixed(decimalPlaces)))
    }

    if (!shouldAnimate) {
      updateText(value)
      return
    }

    updateText(springValue.get())
    return springValue.on("change", updateText)
  }, [springValue, decimalPlaces, formatter, shouldAnimate, value])

  return (
    <span
      ref={ref}
      className={cn(numberTickerTextClassName, className)}
      {...props}
    >
      {shouldAnimate ? startValue : formatter.format(Number(value.toFixed(decimalPlaces)))}
    </span>
  )
}
