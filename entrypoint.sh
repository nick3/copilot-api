#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun --use-system-ca run dist/main.js auth
else
  # Default command
  exec bun --use-system-ca run dist/main.js start -g "$GH_TOKEN" "$@"
fi

