# API and authentication

Client endpoints include `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, and `/v1/models`. A configured provider can be addressed through its provider-scoped routes or a `provider/model` model name. Configured Copilot aliases, including names such as `copilot/claude-opus-5.5`, are resolved before account selection.

Client API keys belong to `auth.apiKeys` and use `x-api-key` or `Authorization: Bearer`. The existing legacy-key fallback remains available unless explicitly disabled. Clearing keys through the Admin UI or CLI disables that fallback. See the [main README](../../../README.md) for binding and client configuration.

The Admin UI is `/admin`; its API uses `/api/admin/*`. Existing localhost/same-origin rules apply. For remote administration set `ADMIN_TOKEN` and send `x-admin-token` or `Authorization: Bearer`. There is no generated `auth.adminApiKey` in this branch.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/config` | Read the editable configuration |
| `POST /api/admin/config` | Validate, save and activate a configuration patch |
| `POST /api/admin/config/reload` | Re-read the saved file and apply it to the running server |

Save responses include `_runtimeApplied`. If it is false, the file was saved but activation failed; retry Reload. Invalid JSON during reload preserves the last active configuration. Request history, account status, quota statistics and replay retain the existing Admin API.
