const numberLocale = "en-US"

export interface AdaptiveNumberFormatCandidate {
  text: string
  formatOptions: Intl.NumberFormatOptions
}

export interface AdaptiveNumberPairCandidate {
  primaryCandidate: AdaptiveNumberFormatCandidate
  secondaryCandidate: AdaptiveNumberFormatCandidate
  text: string
}

export function formatNumberWithOptions(
  value: number,
  formatOptions?: Intl.NumberFormatOptions
): string {
  return Intl.NumberFormat(numberLocale, formatOptions).format(value)
}

function normalizeDecimalPlaces(decimalPlaces = 0): number {
  return Math.max(0, decimalPlaces)
}

function roundNumberForDisplay(value: number, decimalPlaces: number): number {
  return Number(value.toFixed(decimalPlaces))
}

function shouldBuildCompactNumberCandidates(
  value: number,
  decimalPlaces: number
): boolean {
  return Math.abs(roundNumberForDisplay(value, decimalPlaces)) >= 1000
}

function dedupeAdaptiveNumberFormatCandidates(
  candidates: AdaptiveNumberFormatCandidate[]
): AdaptiveNumberFormatCandidate[] {
  const seen = new Set<string>()

  return candidates.filter((candidate) => {
    if (seen.has(candidate.text)) {
      return false
    }

    seen.add(candidate.text)
    return true
  })
}

function dedupeAdaptiveNumberPairCandidates(
  candidates: AdaptiveNumberPairCandidate[]
): AdaptiveNumberPairCandidate[] {
  const seen = new Set<string>()

  return candidates.filter((candidate) => {
    if (seen.has(candidate.text)) {
      return false
    }

    seen.add(candidate.text)
    return true
  })
}

export function buildAdaptiveNumberFormatCandidates(
  value: number,
  decimalPlaces = 0
): AdaptiveNumberFormatCandidate[] {
  const normalizedDecimalPlaces = normalizeDecimalPlaces(decimalPlaces)
  const fullFormatOptions: Intl.NumberFormatOptions = {
    minimumFractionDigits: normalizedDecimalPlaces,
    maximumFractionDigits: normalizedDecimalPlaces,
  }
  const fullCandidate: AdaptiveNumberFormatCandidate = {
    text: formatNumberWithOptions(value, fullFormatOptions),
    formatOptions: fullFormatOptions,
  }

  if (!shouldBuildCompactNumberCandidates(value, normalizedDecimalPlaces)) {
    return [fullCandidate]
  }

  const compactDecimalPlaces = Math.max(1, normalizedDecimalPlaces)
  const compactWithPrecision: AdaptiveNumberFormatCandidate = {
    text: formatNumberWithOptions(value, {
      notation: "compact",
      compactDisplay: "short",
      minimumFractionDigits: compactDecimalPlaces,
      maximumFractionDigits: compactDecimalPlaces,
    }),
    formatOptions: {
      notation: "compact",
      compactDisplay: "short",
      minimumFractionDigits: compactDecimalPlaces,
      maximumFractionDigits: compactDecimalPlaces,
    },
  }
  const compactWithoutFraction: AdaptiveNumberFormatCandidate = {
    text: formatNumberWithOptions(value, {
      notation: "compact",
      compactDisplay: "short",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
    formatOptions: {
      notation: "compact",
      compactDisplay: "short",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    },
  }

  return dedupeAdaptiveNumberFormatCandidates([
    fullCandidate,
    compactWithPrecision,
    compactWithoutFraction,
  ])
}

export function buildAdaptiveNumberPairCandidates(
  primaryValue: number,
  secondaryValue: number,
  primaryDecimalPlaces = 0,
  secondaryDecimalPlaces = 0,
  separator = " / "
): AdaptiveNumberPairCandidate[] {
  const primaryCandidates = buildAdaptiveNumberFormatCandidates(
    primaryValue,
    primaryDecimalPlaces
  )
  const secondaryCandidates = buildAdaptiveNumberFormatCandidates(
    secondaryValue,
    secondaryDecimalPlaces
  )
  const candidates: AdaptiveNumberPairCandidate[] = []
  const maxLevel = primaryCandidates.length + secondaryCandidates.length - 2

  for (let level = 0; level <= maxLevel; level += 1) {
    for (
      let primaryIndex = Math.min(level, primaryCandidates.length - 1);
      primaryIndex >= 0;
      primaryIndex -= 1
    ) {
      const secondaryIndex = level - primaryIndex
      if (secondaryIndex < 0 || secondaryIndex >= secondaryCandidates.length) {
        continue
      }

      const primaryCandidate = primaryCandidates[primaryIndex]
      const secondaryCandidate = secondaryCandidates[secondaryIndex]
      candidates.push({
        primaryCandidate,
        secondaryCandidate,
        text: `${primaryCandidate.text}${separator}${secondaryCandidate.text}`,
      })
    }
  }

  return dedupeAdaptiveNumberPairCandidates(candidates)
}

export function pickAdaptiveNumberFormatCandidate(
  candidates: readonly AdaptiveNumberFormatCandidate[],
  fits: (candidate: AdaptiveNumberFormatCandidate) => boolean
): AdaptiveNumberFormatCandidate {
  return candidates.find(fits) ?? candidates[candidates.length - 1] ?? { text: "", formatOptions: {} }
}

export function pickAdaptiveNumberPairCandidate(
  candidates: readonly AdaptiveNumberPairCandidate[],
  fits: (candidate: AdaptiveNumberPairCandidate) => boolean
): AdaptiveNumberPairCandidate {
  return candidates.find(fits) ?? candidates[candidates.length - 1] ?? {
    primaryCandidate: { text: "", formatOptions: {} },
    secondaryCandidate: { text: "", formatOptions: {} },
    text: "",
  }
}

export function resolveAdaptiveNumberFormatCandidate(
  candidates: readonly AdaptiveNumberFormatCandidate[],
  currentCandidate?: AdaptiveNumberFormatCandidate
): AdaptiveNumberFormatCandidate {
  return candidates.find((candidate) => candidate.text === currentCandidate?.text)
    ?? candidates[candidates.length - 1]
    ?? { text: "", formatOptions: {} }
}

export function resolveAdaptiveNumberPairCandidate(
  candidates: readonly AdaptiveNumberPairCandidate[],
  currentCandidate?: AdaptiveNumberPairCandidate
): AdaptiveNumberPairCandidate {
  return candidates.find((candidate) => candidate.text === currentCandidate?.text)
    ?? candidates[candidates.length - 1]
    ?? {
      primaryCandidate: { text: "", formatOptions: {} },
      secondaryCandidate: { text: "", formatOptions: {} },
      text: "",
    }
}

export function fmtIso(ms?: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

export function fmtLocalDateTime(ms?: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""

  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const min = pad2(d.getMinutes())
  const ss = pad2(d.getSeconds())

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`
}

export function fmtNum(n?: number | null): string {
  if (n == null) return ""
  if (!Number.isFinite(n)) return ""
  return formatNumberWithOptions(n)
}

export function fmtDurationSeconds(ms?: number | null): string {
  if (ms == null) return ""
  if (!Number.isFinite(ms)) return ""
  return (ms / 1000).toFixed(1)
}

export function fmtMaybeNum(n?: number | null): string {
  if (n == null) return ""
  return String(n)
}

export function fmtRelativeTime(ms: number, locale = "en-US"): string {
  const diffSec = Math.round((ms - Date.now()) / 1000)
  const absSec = Math.abs(diffSec)

  let value: number
  let unit: Intl.RelativeTimeFormatUnit

  if (absSec < 60) {
    value = diffSec
    unit = "second"
  } else if (absSec < 3600) {
    value = Math.round(diffSec / 60)
    unit = "minute"
  } else if (absSec < 86400) {
    value = Math.round(diffSec / 3600)
    unit = "hour"
  } else {
    value = Math.round(diffSec / 86400)
    unit = "day"
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  return rtf.format(value, unit)
}
