#!/usr/bin/env sh
# macOS / Linux: one-command developer setup. Same as `npm run setup`; pass --service and/or --tailscale.
set -e
cd "$(dirname "$0")/.."
exec node scripts/setup.mjs "$@"
