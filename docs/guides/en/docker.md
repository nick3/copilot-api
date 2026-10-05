# Docker

Use the repository's `docker-compose.yaml` and the [Docker instructions in the main README](../../../README.md). They retain this branch's image, multi-account registry, token directory, database and data-initialization behavior.

This merge does not change container storage paths or migrate production data. After rebuilding or updating the image, open `/admin` and confirm all accounts are still present. The Copilot provider switch pauses the account pool without deleting its persisted state. Configure `ADMIN_TOKEN` for remote administration; client API keys and Admin authentication are separate.
