#!/bin/sh

container_home_has_state() {
  for state_entry in \
    "$1/config.json" "$1/accounts-registry.json" "$1/tokens" \
    "$1/codex_credentials.json" "$1/models.json" \
    "$1/admin.sqlite" "$1/copilot-api.sqlite" \
    "$1/"*github_token "$1/"*/*github_token
  do
    if [ -e "$state_entry" ] || [ -L "$state_entry" ]; then
      return 0
    fi
  done
  return 1
}

container_home_is_mounted() {
  [ -r "$2" ] || return 1
  # mountinfo is readable even when the old root-owned mount cannot be traversed.
  awk -v target="$1" '$5 == target { found = 1 } END { exit !found }' "$2"
}

resolve_container_data_home() {
  resolve_default_home="$1"
  resolve_legacy_home="$2"
  resolve_explicit_home="$3"
  resolve_mountinfo="${4:-/proc/self/mountinfo}"

  if [ -n "$resolve_explicit_home" ]; then
    printf '%s\n' "$resolve_explicit_home"
    return 0
  fi

  resolve_default_found=false
  resolve_legacy_found=false
  if container_home_has_state "$resolve_default_home" || container_home_is_mounted "$resolve_default_home" "$resolve_mountinfo"; then
    resolve_default_found=true
  fi
  if container_home_has_state "$resolve_legacy_home" || container_home_is_mounted "$resolve_legacy_home" "$resolve_mountinfo"; then
    resolve_legacy_found=true
  fi

  if [ "$resolve_default_found" = true ] && [ "$resolve_legacy_found" = true ]; then
    printf 'Both %s and %s contain API state or are mounted. Set COPILOT_API_HOME (or --api-home) explicitly; refusing to choose or overwrite existing data.\n' "$resolve_default_home" "$resolve_legacy_home" >&2
    return 1
  fi
  if [ "$resolve_legacy_found" = true ]; then
    printf 'Using legacy API home %s. For migration, mount the same host data directory at %s; retain all existing files.\n' "$resolve_legacy_home" "$resolve_default_home" >&2
    printf '%s\n' "$resolve_legacy_home"
    return 0
  fi
  printf '%s\n' "$resolve_default_home"
}

container_home_permission_error() {
  printf 'Cannot access persisted API state: %s (UID:GID %s:%s). Keep the existing data. Mount the same host directory at /data and run docker compose run --rm data-init, or prepare ownership for this UID:GID. Refusing to start with an empty replacement.\n' "$1" "$(id -u)" "$(id -g)" >&2
}

validate_container_data_home() {
  validate_home="$1"
  if ! mkdir -p "$validate_home" || [ ! -r "$validate_home" ] || [ ! -w "$validate_home" ] || [ ! -x "$validate_home" ]; then
    container_home_permission_error "$validate_home"
    return 1
  fi
  for state_dir in "$validate_home/tokens" "$validate_home/cache" "$validate_home/logs"; do
    if [ -e "$state_dir" ] && { [ ! -r "$state_dir" ] || [ ! -w "$state_dir" ] || [ ! -x "$state_dir" ]; }; then
      container_home_permission_error "$state_dir"
      return 1
    fi
  done
  for state_file in \
    "$validate_home/config.json" "$validate_home/accounts-registry.json" \
    "$validate_home/codex_credentials.json" "$validate_home/models.json" \
    "$validate_home/admin.sqlite" "$validate_home/admin.sqlite-"* \
    "$validate_home/copilot-api.sqlite" "$validate_home/copilot-api.sqlite-"* \
    "$validate_home/tokens/"* "$validate_home/"*github_token "$validate_home/"*/*github_token
  do
    if [ -e "$state_file" ] && { [ ! -r "$state_file" ] || [ ! -w "$state_file" ]; }; then
      container_home_permission_error "$state_file"
      return 1
    fi
  done
}
