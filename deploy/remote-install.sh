#!/usr/bin/env bash
# Runs on the EC2 host (from deploy-ec2.sh) inside the unpacked bundle directory.
#   - static site                  → /var/www/vatsim-3d
#   - flight-path store            → /opt/vatsim-3d/tracks.mjs, systemd unit vatsim-tracks (127.0.0.1:8787)
#   - nginx: port 80, plus 443 when a certificate exists. With HTTPS=1, gets one first.
set -euo pipefail
B="$(cd "$(dirname "$0")" && pwd)"
DOMAIN=16-4-34-135.sslip.io
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem

command -v node >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs

sudo mkdir -p /var/www/vatsim-3d /var/www/acme /opt/vatsim-3d
sudo find /var/www/vatsim-3d -mindepth 1 -delete
sudo cp -r "$B/public/." /var/www/vatsim-3d/
sudo chown -R www-data:www-data /var/www/vatsim-3d

sudo cp "$B/tracks.mjs" /opt/vatsim-3d/tracks.mjs
sudo cp "$B/vatsim-tracks.service" /etc/systemd/system/vatsim-tracks.service
sudo systemctl daemon-reload
sudo systemctl enable -q vatsim-tracks
sudo systemctl restart vatsim-tracks

write_nginx() {
  sudo cp "$B/nginx-vatsim-3d-site.conf" /etc/nginx/snippets/vatsim-3d-site.conf
  sudo cp "$B/nginx-vatsim-3d-http.conf" /etc/nginx/sites-available/vatsim-3d
  if sudo test -f "$CERT"; then sudo tee -a /etc/nginx/sites-available/vatsim-3d < "$B/nginx-vatsim-3d-https.conf" >/dev/null; fi
  sudo nginx -t -q && sudo systemctl reload nginx
}
write_nginx

if [ "${HTTPS:-0}" = 1 ] && ! sudo test -f "$CERT"; then
  command -v certbot >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
  sudo certbot certonly -n --agree-tos --register-unsafely-without-email --webroot -w /var/www/acme -d "$DOMAIN" \
    --deploy-hook "systemctl reload nginx"
  write_nginx
fi

sleep 2
echo "vatsim-tracks: $(systemctl is-active vatsim-tracks)  https: $(sudo test -f "$CERT" && echo yes || echo no)"
