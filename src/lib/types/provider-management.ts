export type ProviderModelOptions = Record<string, Array<string>>

export interface ProviderManagementConfig {
  configPath: string
  providers: Array<{
    name: string
    type: string
    enabled: boolean
    codexModels?: Array<string>
  }>
}

export interface ProviderManagementUpdate {
  providers?: Record<
    string,
    { enabled?: boolean; codexModels?: Array<string> | null }
  >
}
