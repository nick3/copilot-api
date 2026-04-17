import { getConfig } from "./config"

export function isDevModeEnabled(): boolean {
  return getConfig().devMode?.enabled === true
}

export function isCapture4xxEnabled(): boolean {
  return getConfig().devMode?.capture4xx === true
}
