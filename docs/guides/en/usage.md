# Usage monitoring

Open `/admin` after starting the gateway. The existing Accounts, Requests, Statistics and Token Usage pages provide per-account status, quota snapshots, request details and usage history. Developer capture and replay remain available through the existing [developer-mode guide](../../developer-mode.md).

Costs can come from explicit provider prices, cached model metadata, or an upstream-reported cost. Codex service tiers affect estimates. Estimated cost is not a subscription invoice; currency and pricing source should be checked when comparing providers. History is not recomputed by this merge. Daily token usage buckets follow the server's local calendar date.

This branch does not ship the separate upstream Usage Viewer or Electron application.
