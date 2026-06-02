<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# workflows

## Purpose
GitHub Actions CI/CD workflows for building, testing, and deploying the project.

## Key Files

| File | Description |
|------|-------------|
| `ci.yml` | Continuous integration: lint, test, typecheck |
| `deploy-pages.yml` | Deploy GitHub Pages (admin UI) |
| `dockerhub.yml` | Build and push to Docker Hub |
| `release.yml` | Release automation (npm publish) |
| `release-docker.yml` | Docker release workflow |

## For AI Agents

### Working In This Directory
- Workflows are triggered by git events (push, PR, release)
- CI runs on every PR to the `all` branch
- Docker builds publish container images for deployment
