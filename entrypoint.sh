#!/bin/sh
set -eu

. "$(dirname "$0")/docker-data-home.sh"

export HOST="${HOST:-0.0.0.0}"
export COPILOT_API_GITHUB_TOKEN="${COPILOT_API_GITHUB_TOKEN:-${GH_TOKEN:-}}"

data_home="${COPILOT_API_HOME:-}"
expect_home=false
check_home=true
for argument in "$@"; do
  if [ "$expect_home" = true ]; then
    data_home="$argument"
    expect_home=false
    continue
  fi
  case "$argument" in
    --api-home) expect_home=true ;;
    --api-home=*) data_home="${argument#--api-home=}" ;;
    --help|-h|--version) check_home=false ;;
  esac
done

if [ "$check_home" = true ]; then
  data_home="$(resolve_container_data_home /data /root/.local/share/copilot-api "$data_home")"
  validate_container_data_home "$data_home"
  export COPILOT_API_HOME="$data_home"
  printf 'Using API home: %s\n' "$data_home" >&2
fi

if [ "$#" -gt 0 ] && [ "$1" = "--auth" ]; then
  shift
  exec bun --use-system-ca run dist/main.js auth "$@"
fi

if [ "$#" -gt 0 ] && [ "$1" = "auth" ]; then
  exec bun --use-system-ca run dist/main.js "$@"
fi

if [ "$#" -gt 0 ] && [ "$1" = "start" ]; then
  shift
fi

exec bun --use-system-ca run dist/main.js start "$@"
