import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ComponentPropsWithoutRef } from "react"

import {
  buildAdaptiveNumberFormatCandidates,
  buildAdaptiveNumberPairCandidates,
  pickAdaptiveNumberFormatCandidate,
  pickAdaptiveNumberPairCandidate,
  resolveAdaptiveNumberFormatCandidate,
  resolveAdaptiveNumberPairCandidate,
  type AdaptiveNumberFormatCandidate,
  type AdaptiveNumberPairCandidate,
} from "@/lib/format"
import { cn } from "@/lib/utils"

import { NumberTicker, numberTickerTextClassName } from "./number-ticker"

interface AdaptiveNumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  direction?: "up" | "down"
  delay?: number
  decimalPlaces?: number
}

interface AdaptiveNumberPairProps extends ComponentPropsWithoutRef<"div"> {
  primaryValue: number
  secondaryValue: number
  primaryStartValue?: number
  primaryDirection?: "up" | "down"
  primaryDelay?: number
  primaryDecimalPlaces?: number
  secondaryDecimalPlaces?: number
  separator?: string
}

interface MeasuredAdaptiveNumberTickerProps extends AdaptiveNumberTickerProps {
  candidates: AdaptiveNumberFormatCandidate[]
}

interface MeasuredAdaptiveNumberPairProps extends Omit<AdaptiveNumberPairProps, "secondaryValue" | "secondaryDecimalPlaces"> {
  candidates: AdaptiveNumberPairCandidate[]
}

const adaptiveNumberContainerClassName = "block min-w-0 max-w-full grow overflow-hidden"
const adaptiveMeasureClassName = "pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
const secondaryNumberTextClassName = "text-muted-foreground text-sm whitespace-nowrap"
const fallbackCandidate: AdaptiveNumberFormatCandidate = {
  text: "",
  formatOptions: {},
}
const fallbackPairCandidate: AdaptiveNumberPairCandidate = {
  primaryCandidate: fallbackCandidate,
  secondaryCandidate: fallbackCandidate,
  text: "",
}

export function AdaptiveNumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}: AdaptiveNumberTickerProps) {
  const candidates = useMemo(
    () => buildAdaptiveNumberFormatCandidates(value, decimalPlaces),
    [value, decimalPlaces]
  )

  if (candidates.length === 1) {
    const candidate = candidates[0] ?? fallbackCandidate

    return (
      <span
        className={cn(adaptiveNumberContainerClassName, className)}
        {...props}
      >
        <NumberTicker
          value={value}
          startValue={startValue}
          direction={direction}
          delay={delay}
          decimalPlaces={decimalPlaces}
          formatOptions={candidate.formatOptions}
          className="whitespace-nowrap"
        />
      </span>
    )
  }

  return (
    <MeasuredAdaptiveNumberTicker
      value={value}
      startValue={startValue}
      direction={direction}
      delay={delay}
      decimalPlaces={decimalPlaces}
      className={className}
      candidates={candidates}
      {...props}
    />
  )
}

export function AdaptiveNumberPair({
  primaryValue,
  secondaryValue,
  primaryStartValue = 0,
  primaryDirection = "up",
  primaryDelay = 0,
  className,
  primaryDecimalPlaces = 0,
  secondaryDecimalPlaces = 0,
  separator = " / ",
  ...props
}: AdaptiveNumberPairProps) {
  const candidates = useMemo(
    () =>
      buildAdaptiveNumberPairCandidates(
        primaryValue,
        secondaryValue,
        primaryDecimalPlaces,
        secondaryDecimalPlaces,
        separator
      ),
    [
      primaryValue,
      secondaryValue,
      primaryDecimalPlaces,
      secondaryDecimalPlaces,
      separator,
    ]
  )

  if (candidates.length === 1) {
    const candidate = candidates[0] ?? fallbackPairCandidate

    return (
      <div
        className={cn("relative flex min-w-0 items-baseline gap-1 overflow-hidden", className)}
        {...props}
      >
        <span className={adaptiveNumberContainerClassName}>
          <NumberTicker
            value={primaryValue}
            startValue={primaryStartValue}
            direction={primaryDirection}
            delay={primaryDelay}
            decimalPlaces={primaryDecimalPlaces}
            formatOptions={candidate.primaryCandidate.formatOptions}
            className="whitespace-nowrap"
          />
        </span>
        <span className={cn(secondaryNumberTextClassName, "shrink-0")}>
          {separator}{candidate.secondaryCandidate.text}
        </span>
      </div>
    )
  }

  return (
    <MeasuredAdaptiveNumberPair
      primaryValue={primaryValue}
      primaryStartValue={primaryStartValue}
      primaryDirection={primaryDirection}
      primaryDelay={primaryDelay}
      primaryDecimalPlaces={primaryDecimalPlaces}
      separator={separator}
      className={className}
      candidates={candidates}
      {...props}
    />
  )
}

function MeasuredAdaptiveNumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  candidates,
  ...props
}: MeasuredAdaptiveNumberTickerProps) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<AdaptiveNumberFormatCandidate>(
    () => candidates[candidates.length - 1] ?? fallbackCandidate
  )

  const renderCandidate = resolveAdaptiveNumberFormatCandidate(
    candidates,
    selectedCandidate
  )

  const syncCandidate = useCallback(() => {
    const container = containerRef.current
    const measure = measureRef.current

    if (!container || !measure) {
      return
    }

    const availableWidth = container.clientWidth
    if (availableWidth <= 0) {
      return
    }

    const nextCandidate = pickAdaptiveNumberFormatCandidate(candidates, (candidate) => {
      measure.textContent = candidate.text
      return measure.scrollWidth <= availableWidth
    })

    setSelectedCandidate((currentCandidate) => {
      const currentRenderCandidate = resolveAdaptiveNumberFormatCandidate(
        candidates,
        currentCandidate
      )
      if (currentRenderCandidate.text === nextCandidate.text) {
        return currentCandidate
      }

      return nextCandidate
    })
  }, [candidates])

  useEffect(() => {
    syncCandidate()

    const container = containerRef.current
    if (!container) {
      return
    }

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncCandidate)
      return () => {
        window.removeEventListener("resize", syncCandidate)
      }
    }

    const resizeObserver = new ResizeObserver(syncCandidate)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [syncCandidate])

  return (
    <span
      ref={containerRef}
      className={cn("relative", adaptiveNumberContainerClassName, className)}
      {...props}
    >
      <NumberTicker
        value={value}
        startValue={startValue}
        direction={direction}
        delay={delay}
        decimalPlaces={decimalPlaces}
        formatOptions={renderCandidate.formatOptions}
        className="whitespace-nowrap"
      />
      <span
        ref={measureRef}
        aria-hidden
        className={cn(adaptiveMeasureClassName, numberTickerTextClassName)}
      />
    </span>
  )
}

function MeasuredAdaptiveNumberPair({
  primaryValue,
  primaryStartValue = 0,
  primaryDirection = "up",
  primaryDelay = 0,
  className,
  primaryDecimalPlaces = 0,
  separator = " / ",
  candidates,
  ...props
}: MeasuredAdaptiveNumberPairProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const measurePrimaryRef = useRef<HTMLSpanElement>(null)
  const measureSecondaryRef = useRef<HTMLSpanElement>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<AdaptiveNumberPairCandidate>(
    () => candidates[candidates.length - 1] ?? fallbackPairCandidate
  )

  const renderCandidate = resolveAdaptiveNumberPairCandidate(
    candidates,
    selectedCandidate
  )

  const syncCandidate = useCallback(() => {
    const container = containerRef.current
    const measure = measureRef.current
    const measurePrimary = measurePrimaryRef.current
    const measureSecondary = measureSecondaryRef.current

    if (!container || !measure || !measurePrimary || !measureSecondary) {
      return
    }

    const availableWidth = container.clientWidth
    if (availableWidth <= 0) {
      return
    }

    const nextCandidate = pickAdaptiveNumberPairCandidate(candidates, (candidate) => {
      measurePrimary.textContent = candidate.primaryCandidate.text
      measureSecondary.textContent = `${separator}${candidate.secondaryCandidate.text}`
      return measure.scrollWidth <= availableWidth
    })

    setSelectedCandidate((currentCandidate) => {
      const currentRenderCandidate = resolveAdaptiveNumberPairCandidate(
        candidates,
        currentCandidate
      )
      if (currentRenderCandidate.text === nextCandidate.text) {
        return currentCandidate
      }

      return nextCandidate
    })
  }, [candidates, separator])

  useEffect(() => {
    syncCandidate()

    const container = containerRef.current
    if (!container) {
      return
    }

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncCandidate)
      return () => {
        window.removeEventListener("resize", syncCandidate)
      }
    }

    const resizeObserver = new ResizeObserver(syncCandidate)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [syncCandidate])

  return (
    <div
      ref={containerRef}
      className={cn("relative flex min-w-0 items-baseline gap-1 overflow-hidden", className)}
      {...props}
    >
      <span className={adaptiveNumberContainerClassName}>
        <NumberTicker
          value={primaryValue}
          startValue={primaryStartValue}
          direction={primaryDirection}
          delay={primaryDelay}
          decimalPlaces={primaryDecimalPlaces}
          formatOptions={renderCandidate.primaryCandidate.formatOptions}
          className="whitespace-nowrap"
        />
      </span>
      <span className={cn(secondaryNumberTextClassName, "shrink-0")}>
        {separator}{renderCandidate.secondaryCandidate.text}
      </span>
      <div
        ref={measureRef}
        aria-hidden
        className={cn(adaptiveMeasureClassName, "flex items-baseline gap-1")}
      >
        <span
          ref={measurePrimaryRef}
          className={numberTickerTextClassName}
        />
        <span
          ref={measureSecondaryRef}
          className={secondaryNumberTextClassName}
        />
      </div>
    </div>
  )
}
