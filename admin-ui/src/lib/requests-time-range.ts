const MINUTE_END_OFFSET_MS = 59_999

function parseLocalInputMs(value: string): number | null {
  if (!value) return null

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function localInputToFromMs(value: string): string {
  const ms = parseLocalInputMs(value)
  return ms == null ? "" : String(ms)
}

export function localInputToToMs(value: string): string {
  const ms = parseLocalInputMs(value)
  return ms == null ? "" : String(ms + MINUTE_END_OFFSET_MS)
}

export function msToLocalInput(ms: string): string {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ""

  const d = new Date(n)
  const pad2 = (x: number) => String(x).padStart(2, "0")
  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const min = pad2(d.getMinutes())

  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}
