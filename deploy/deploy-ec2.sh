#!/usr/bin/env bash
# Deploy the site and the flight-path store to the EC2 host (see deploy/remote-install.sh).
# Usage: deploy/deploy-ec2.sh [--https] [path-to-pem] [user@host]
#   --https  also get a Let's Encrypt certificate for 16-4-34-135.sslip.io (first time only;
#            accepts the Let's Encrypt subscriber agreement) and serve HTTPS on 443.
set -euo pipefail

HTTPS=0
if [ "${1:-}" = "--https" ]; then HTTPS=1; shift; fi
KEY="${1:-$HOME/Downloads/ec2_in.pem}"
HOST="${2:-ubuntu@16.4.34.135}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/public"
cp -r "$ROOT/public/." "$STAGE/public/"
cp "$ROOT/server/tracks.mjs" "$ROOT"/deploy/vatsim-tracks.service "$ROOT"/deploy/nginx-vatsim-3d-*.conf "$ROOT/deploy/remote-install.sh" "$STAGE/"

tar czf - -C "$STAGE" . | ssh -i "$KEY" "$HOST" \
  "set -e; T=\$(mktemp -d); tar xzf - -C \$T; HTTPS=$HTTPS bash \$T/remote-install.sh; rm -rf \$T"
echo "Deployed to http://${HOST#*@}/"
