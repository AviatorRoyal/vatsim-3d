#!/usr/bin/env bash
# Push the static site in public/ to the EC2 host, where nginx serves it on port 80.
# Usage: deploy/deploy-ec2.sh [path-to-pem] [user@host]
set -euo pipefail

KEY="${1:-$HOME/Downloads/ec2_in.pem}"
HOST="${2:-ubuntu@16.4.34.135}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

tar czf - -C "$ROOT/public" . | ssh -i "$KEY" "$HOST" '
  set -e
  sudo mkdir -p /var/www/vatsim-3d
  sudo find /var/www/vatsim-3d -mindepth 1 -delete
  sudo tar xzf - -C /var/www/vatsim-3d
  sudo chown -R www-data:www-data /var/www/vatsim-3d
  sudo systemctl reload nginx
'
echo "Deployed to http://${HOST#*@}/"
