# Configuration

The file is `$COPILOT_API_HOME/config.json`, defaulting to `~/.local/share/copilot-api/config.json`. Existing options are described in the [main README](../../../README.md). This merge adds the following settings:

```json
{
  "smallModels": {"copilot": "gpt-6-luna", "codex": "gpt-6-luna"},
  "providers": {
    "github-copilot": {"enabled": true, "codexModels": ["claude-opus-5.5"]},
    "example": {
      "type": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "apiKey": "YOUR_PROVIDER_KEY",
      "modelsDevProviderId": "openai"
    }
  },
  "modelAliases": {"copilot/claude-opus-5.5": {"target": "claude-opus-5.5", "allowOriginal": false}}
}
```

Model names are examples; use models actually available to your accounts.

- `providers.github-copilot.enabled` controls the entire Copilot account pool, while individual account switches remain independent. Disabling retains credentials, pauses refresh and rejects new Copilot requests. It does not disable other providers or Admin UI.
- `codexModels` controls only the Codex client model catalog. Omit it for automatic selection, use `[]` to hide all models, or list upstream IDs. Explicit per-model `models.<id>.codex.enabled: false` still wins. Ordinary API access is unchanged.
- `modelsDevProviderId` associates a provider with cached models.dev protocol/capability/pricing metadata. Explicit model prices and authentication settings retain priority. A cold-cache network failure does not prevent the gateway or Admin UI from starting.
- `smallModels` selects small models by provider. Legacy `smallModel` remains a fallback for Copilot when `smallModels.copilot` is absent. An explicitly empty value disables the optional task-title override. Warmup/compaction keeps the Copilot fallback behavior.
- New installations include Codex auto-review/reserve mappings. Existing explicit `modelMappings` are preserved; clearing the map remains possible.
- One-hour Anthropic cache control is forwarded only when the client requests its supported beta. No one-hour TTL is added automatically.

Edit these settings in Admin UI. Saving activates the configuration; Reload also applies external file edits. See [API](api.md) for saved-versus-active status.
