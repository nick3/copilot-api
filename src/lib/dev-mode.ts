import { getConfig } from "./config"

export function isDevModeEnabled(): boolean {
  return getConfig().devMode?.enabled === true
}

export function isCapture4xxEnabled(): boolean {
  return getConfig().devMode?.capture4xx === true
}

export function isCapture5xxEnabled(): boolean {
  return getConfig().devMode?.capture5xx === true
}

export function isCaptureOtherEnabled(): boolean {
  return getConfig().devMode?.captureOther === true
}
